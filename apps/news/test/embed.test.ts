import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { Embedder } from "../src/embed/Embedder";
import { VariantMismatch } from "../src/errors";
import { Embeddings } from "../src/repos/Embeddings";
import { dbUp, rolledBack } from "./helpers";

const cfg = { baseUrl: "http://ollama.test/v1", model: "m", dim: 3, prefix: "P: " };

/** Stub Ollama: returns `respond(inputs)` and records the request bodies it saw. */
const stub = (respond: (input: string[]) => unknown, seen: { body?: any } = {}) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => {
      seen.body = JSON.parse(new TextDecoder().decode((req.body as any).body));
      return Effect.succeed(HttpClientResponse.fromWeb(req, Response.json(respond(seen.body.input))));
    }),
  );

const run = <A, E>(layer: Layer.Layer<HttpClient.HttpClient>, f: (e: Embedder["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(Effect.gen(function* () { return yield* f(yield* Embedder.make(cfg)); }).pipe(Effect.provide(layer)));

test("embed: applies the prefix, sends dimensions, returns unit vectors in index order", async () => {
  const seen: { body?: any } = {};
  // deliberately out of order and not normalised
  const exit = await run(stub((input) => ({ data: input.map((_, i) => ({ index: i, embedding: [3 * (i + 1), 4 * (i + 1), 0] })).reverse() }), seen), (e) => e.embed(["a", "b"]));
  expect(seen.body).toMatchObject({ model: "m", input: ["P: a", "P: b"], dimensions: 3 });
  const v = (exit as any).value as Float32Array[];
  expect(Array.from(v[0]!).map((x) => +x.toFixed(3))).toEqual([0.6, 0.8, 0]);
  expect(Math.hypot(...v[1]!)).toBeCloseTo(1, 5);
});

test("embed: wrong dimension or count is an EmbedError", async () => {
  const badDim = await run(stub((i) => ({ data: i.map((_, k) => ({ index: k, embedding: [1, 0] })) })), (e) => e.embed(["a"]));
  expect(JSON.stringify(badDim)).toContain("EmbedError");
  expect(JSON.stringify(badDim)).toContain("returned 2-dim");
  const badCount = await run(stub(() => ({ data: [] })), (e) => e.embed(["a"]));
  expect(JSON.stringify(badCount)).toContain("asked for 1 embeddings, got 0");
});

test("variant identifies model, dimension and prefix", async () => {
  const e = await Effect.runPromise(Embedder.make(cfg).pipe(Effect.provide(stub(() => ({ data: [] })))));
  expect(e.variant).toBe("m|3|P: ");
});

// ---- real Postgres, rolled back ----
const vec = (...xs: number[]) => Float32Array.from([...xs, ...Array(768 - xs.length).fill(0)]);

test.skipIf(!dbUp)("Embeddings: variant pin, pending, save, frozen mean + centring in SQL", async () => {
  const out = await rolledBack(
    Embeddings.layer,
    Effect.gen(function* () {
      const emb = yield* Embeddings;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`delete from embeddings`;
      yield* sql`delete from embedding_state`;

      yield* emb.ensureVariant("v1");
      yield* emb.ensureVariant("v1"); // same variant is fine
      const mismatch = yield* emb.ensureVariant("v2").pipe(Effect.flip);

      const urls = [`https://embed.test/${crypto.randomUUID()}`, `https://embed.test/${crypto.randomUUID()}`];
      for (const [i, url] of urls.entries()) {
        yield* sql`insert into urls (url, domain, seen_at) values (${url}, 'embed.test', now())`;
        yield* sql`insert into articles (url, domain, title, lede, seen_at) values (${url}, 'embed.test', ${"embed-test " + i}, 'lede text', now())`;
      }
      const keys = (yield* sql<{ embedKey: string }>`select embed_key from articles where domain = 'embed.test' order by title`).map((r) => r.embedKey);

      const pendingBefore = (yield* emb.pending(1_000_000)).filter((p) => p.title.startsWith("embed-test")).length;
      yield* emb.save([{ embedKey: keys[0]!, vec: vec(1) }, { embedKey: keys[1]!, vec: vec(0, 1) }]);
      const pendingAfter = (yield* emb.pending(1_000_000)).filter((p) => p.title.startsWith("embed-test")).length;
      const cvecBeforeMean = (yield* sql<{ n: number }>`select count(*)::int as n from embeddings where cvec is not null`)[0]!.n;

      const notYet = yield* emb.freezeMeanIfReady(3); // only 2 vectors
      const froze = yield* emb.freezeMeanIfReady(2);
      const again = yield* emb.freezeMeanIfReady(2); // mean is frozen once
      const head = (k: string) => sql<{ c: string }>`select cvec::text as c from embeddings where embed_key = ${k}`.pipe(Effect.map((r) => JSON.parse(r[0]!.c).slice(0, 3) as number[]));
      const centredA = yield* head(keys[0]!);

      // a later vector is centred against the frozen mean on write
      const k3 = "k3-" + crypto.randomUUID();
      yield* emb.save([{ embedKey: k3, vec: vec(0, 0, 1) }]);
      const centredNew = yield* head(k3);
      const stats = yield* emb.stats;
      return { mismatch, pendingBefore, pendingAfter, cvecBeforeMean, notYet, froze, again, centredA, centredNew, stats };
    }).pipe(Effect.orDie),
  );

  expect(out.mismatch).toBeInstanceOf(VariantMismatch);
  expect(out).toMatchObject({ pendingBefore: 2, pendingAfter: 0, cvecBeforeMean: 0, notYet: false, froze: true, again: false });
  // mean of e0,e1 = (.5,.5,0..); e0 - mean = (.5,-.5,0) -> normalised (.7071,-.7071,0)
  expect(out.centredA.map((x) => +x.toFixed(3))).toEqual([0.707, -0.707, 0]);
  // e2 - mean = (-.5,-.5,1) -> / sqrt(1.5)
  expect(out.centredNew.map((x) => +x.toFixed(3))).toEqual([-0.408, -0.408, 0.816]);
  expect(out.stats).toMatchObject({ variant: "v1", embedded: 3, centered: 3, meanVersion: 1 });
});
