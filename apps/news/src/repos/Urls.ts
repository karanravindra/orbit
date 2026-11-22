import { createHash } from "node:crypto";
import { Array as Arr, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { GdeltRow } from "../gdelt/parse";

/** What a fetch job carries. */
export interface UrlJob {
  readonly url: string;
  readonly domain: string;
  readonly seenAt: Date;
}

const hostname = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

const CHUNK = 1000;

/** Requeue cursor. Paging in md5 order (not url order) interleaves domains instead of queueing one outlet's URLs back to back. */
export const urlKey = (url: string): string => createHash("md5").update(url).digest("hex");

/**
 * The `urls` table as a *ledger* (dedupe + status: pending → ok | failed) plus the `gdelt_slices` record.
 * BullMQ owns the work in flight; this is the source of truth if Redis is ever lost. DB failures are defects.
 */
export class Urls extends Context.Service<Urls, {
  /** Slice timestamps (ms) already ingested since `since`. */
  ingestedSlices(since: Date): Effect.Effect<ReadonlySet<number>>;
  /** Insert a slice's URLs and record the slice atomically. Returns the URLs that were new. */
  ingestSlice(ts: Date, rows: ReadonlyArray<GdeltRow>): Effect.Effect<ReadonlyArray<UrlJob>>;
  /** One page of not-yet-finished URLs after cursor `after` (a `urlKey`), for re-enqueueing after a crash or Redis loss. */
  unfinished(after: string, limit: number): Effect.Effect<ReadonlyArray<UrlJob>>;
  /** Out of attempts, or a permanent failure. */
  markFailed(url: string, message: string): Effect.Effect<void>;
  /** Failed an attempt but BullMQ will retry; keeps the reason visible in SQL. */
  markRetry(url: string, message: string): Effect.Effect<void>;
}>()("news/repos/Urls") {
  static readonly layer = Layer.effect(
    Urls,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const ingestedSlices = Effect.fn("Urls.ingestedSlices")(function* (since: Date) {
        const rows = yield* sql<{ ts: Date }>`select ts from gdelt_slices where kind = 'gkg' and ts >= ${since}`;
        return new Set(rows.map((r) => r.ts.getTime())) as ReadonlySet<number>;
      }, Effect.orDie);

      const ingestSlice = Effect.fn("Urls.ingestSlice")(function* (ts: Date, rows: ReadonlyArray<GdeltRow>) {
        const seen = new Set<string>();
        const data: { url: string; domain: string; seenAt: Date; titleHint: string | null }[] = [];
        for (const r of rows) {
          const domain = hostname(r.url);
          if (!domain || seen.has(r.url)) continue;
          seen.add(r.url);
          data.push({ url: r.url, domain, seenAt: r.seen, titleHint: r.titleHint });
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const fresh: UrlJob[] = [];
            for (const chunk of Arr.chunksOf(data, CHUNK)) {
              const res = yield* sql<UrlJob>`insert into urls ${sql.insert(chunk)} on conflict (url) do nothing returning url, domain, seen_at`;
              fresh.push(...res);
            }
            yield* sql`insert into gdelt_slices (ts, kind, n_urls) values (${ts}, 'gkg', ${rows.length}) on conflict do nothing`;
            return fresh as ReadonlyArray<UrlJob>;
          }),
        );
      }, Effect.orDie);

      const unfinished = Effect.fn("Urls.unfinished")(function* (after: string, limit: number) {
        const rows = yield* sql<UrlJob>`
          select url, domain, seen_at from urls
          where fetch_status in ('pending', 'retry') and md5(url) collate "C" > ${after}
          order by md5(url) collate "C" limit ${limit}`;
        return rows as ReadonlyArray<UrlJob>;
      }, Effect.orDie);

      const mark = (status: "failed" | "retry") =>
        Effect.fn(`Urls.mark_${status}`)(function* (url: string, message: string) {
          yield* sql`update urls set fetch_status = ${status}, last_status = ${message}, updated_at = now() where url = ${url}`;
        }, Effect.orDie);

      return Urls.of({ ingestedSlices, ingestSlice, unfinished, markFailed: mark("failed"), markRetry: mark("retry") });
    }),
  );
}
