import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { PgLive } from "../src/db/Db";
import type { Extracted } from "../src/extract/extract";
import { Articles } from "../src/repos/Articles";
import { Urls, urlKey } from "../src/repos/Urls";
import { dbUp, rolledBack } from "./helpers";

// Real-Postgres smoke test: catches SQL drifting from the schema (e.g. a migration dropping a column a query still uses).
// Everything runs in one transaction that is rolled back, so it leaves no rows behind. Skipped when the DB is down.
const Live = Layer.mergeAll(Urls.layer, Articles.layer);

const extracted: Extracted = { title: "T", sitename: null, publishedAt: null, lede: "l", body: "b", titleKey: "t", textHash: "h", imageUrl: null, rejectReason: null };

test.skipIf(!dbUp)("ledger + article queries match the schema", async () => {
  const url = `https://smoke.test/${crypto.randomUUID()}`;
  const other = `https://smoke.test/${crypto.randomUUID()}`;
  const seen = new Date("2000-01-01T00:00:00Z");

  const result = await rolledBack(
    Live,
    Effect.gen(function* () {
        const urls = yield* Urls;
        const sql = yield* SqlClient.SqlClient;
        const status = (u: string) => sql<{ fetchStatus: string; lastStatus: string | null }>`select fetch_status, last_status from urls where url = ${u}`.pipe(Effect.map((r) => r[0]), Effect.orDie);

        const ts = new Date("2000-01-01T00:15:00Z");
        const fresh = yield* urls.ingestSlice(ts, [{ url, seen, titleHint: null }, { url: other, seen, titleHint: "x" }]);
        const again = yield* urls.ingestSlice(ts, [{ url, seen, titleHint: null }]); // already known => nothing new
        expect((yield* urls.ingestedSlices(new Date("1999-12-31T00:00:00Z"))).has(ts.getTime())).toBe(true);

        const page = yield* urls.unfinished("", 100_000);
        const listed = page.filter((j) => j.url === url || j.url === other).map((j) => j.url);

        const job = fresh.find((j) => j.url === url)!;
        yield* (yield* Articles).save(job, extracted);
        const afterSave = yield* status(url);
        yield* urls.markRetry(other, "http 429");
        const afterRetry = yield* status(other);
        yield* urls.markFailed(other, "http 403");
        const afterFail = yield* status(other);
        const stillListed = (yield* urls.unfinished("", 100_000)).some((j) => j.url === url);
        return { fresh: fresh.length, again: again.length, listed: listed.length, job, afterSave, afterRetry, afterFail, stillListed };
      }),
  );

  expect(result).toMatchObject({ fresh: 2, again: 0, listed: 2, stillListed: false });
  expect(result.job).toMatchObject({ url, domain: "smoke.test" });
  expect(result.job.seenAt).toEqual(seen);
  expect(result.afterSave).toMatchObject({ fetchStatus: "ok", lastStatus: "ok" });
  expect(result.afterRetry).toMatchObject({ fetchStatus: "retry", lastStatus: "http 429" });
  expect(result.afterFail).toMatchObject({ fetchStatus: "failed", lastStatus: "http 403" });
});

test("urlKey matches Postgres md5()", async () => {
  if (!dbUp) return;
  const url = "https://example.com/é?x=1";
  const rows = await Effect.runPromise(
    SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql<{ k: string }>`select md5(${url}) as k`), Effect.provide(PgLive)),
  );
  expect(rows[0]!.k).toBe(urlKey(url));
});
