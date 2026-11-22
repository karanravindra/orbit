import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { Gdelt } from "../src/gdelt/Gdelt";
import { SLICE_MS } from "../src/gdelt/parse";
import { Ingest } from "../src/pipeline/Ingest";
import { FetchQueue } from "../src/queue/FetchQueue";
import { Urls, type UrlJob } from "../src/repos/Urls";

// Ingest against in-memory fakes: no network, no database, no Redis.
test("ingests only unseen, published slices and enqueues the new urls", async () => {
  const latest = new Date("2025-11-19T21:30:00Z");
  const ingested: number[] = [];
  const enqueued: string[] = [];
  const row = { url: "https://a.com/x", seen: latest, titleHint: null };
  const job = (ts: Date): UrlJob => ({ url: `https://a.com/${ts.getTime()}`, domain: "a.com", seenAt: ts });

  const FakeGdelt = Layer.succeed(Gdelt, Gdelt.of({
    latestSlice: Effect.succeed(latest),
    // the newest slice isn't published yet
    slice: (ts) => Effect.succeed(ts.getTime() === latest.getTime() ? Option.none() : Option.some([row])),
  }));
  const FakeUrls = Layer.succeed(Urls, Urls.of({
    ingestedSlices: () => Effect.succeed(new Set([latest.getTime() - 2 * SLICE_MS])),
    ingestSlice: (ts) => Effect.sync(() => (ingested.push(ts.getTime()), [job(ts)])),
    unfinished: () => Effect.succeed([]),
    markFailed: () => Effect.void,
    markRetry: () => Effect.void,
  }));
  const FakeQueue = Layer.succeed(FetchQueue, FetchQueue.of({
    enqueue: (jobs) => Effect.sync(() => (enqueued.push(...jobs.map((j) => j.url)), jobs.length)),
    requeueUnfinished: Effect.succeed(0),
    start: () => Effect.void,
    counts: Effect.succeed({}),
  }));

  const total = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Ingest).run(1);
    }).pipe(Effect.provide(Ingest.layer.pipe(Layer.provide(Layer.mergeAll(FakeGdelt, FakeUrls, FakeQueue))))),
  );
  // window = 20:30..21:30 -> 5 slices; 21:00 already ingested, 21:30 unpublished -> 3 ingested
  const expected = [4, 3, 1].map((n) => latest.getTime() - n * SLICE_MS);
  expect(ingested).toEqual(expected);
  expect(enqueued).toEqual(expected.map((t) => `https://a.com/${t}`));
  expect(total).toBe(3);
});
