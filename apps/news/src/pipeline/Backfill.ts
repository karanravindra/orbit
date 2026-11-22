import { Context, Effect, Layer } from "effect";
import { HttpClientRequest } from "effect/http";
import { SqlClient } from "effect/sql";
import { cleanLede, extract, isBoilerplate } from "../extract/extract";
import { lowQuality } from "../extract/quality";
import { PoliteClient } from "../http/PoliteClient";

const UA = "Mozilla/5.0 (compatible; orbit-news/0.1)";
const MAX_BYTES = 2_000_000;
const LEDE_CHARS = 600;

/** One-off repairs over rows that predate a fix. DB failures are defects. */
export class Backfill extends Context.Service<Backfill, {
  /**
   * Fetch the share image for a few articles of each story that lacks one (up to `perStory`, preferring rated
   * outlets). Pages without an image are marked '' so they are not retried. Returns [looked at, found].
   */
  images(limit: number, perStory?: number): Effect.Effect<readonly [number, number]>;
  /**
   * Replace ledes that are paywall/cookie banners with the first clean paragraph (or reject the page when none),
   * then drop embeddings no article refers to. Run `embed` and `cluster --rebuild` afterwards. Returns [fixed, rejected].
   */
  cleanLedes: Effect.Effect<readonly [number, number]>;
  /** Reject stored press releases, news roundups and listicles (see extract/quality). Returns the count rejected, by reason. */
  quality: Effect.Effect<Readonly<Record<string, number>>>;
}>()("news/pipeline/Backfill") {
  static readonly layer = Layer.effect(
    Backfill,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const http = yield* PoliteClient;

      const images = Effect.fn("Backfill.images")(function* (limit: number, perStory = 4) {
        const todo = yield* sql<{ id: number; url: string }>`
          select id, url from (
            select a.id, a.url, row_number() over (
              partition by t.story_id order by (select count(*) from outlets o where a.domain = o.domain) desc, a.seen_at desc) as rn
            from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
            where a.image_url is null) x
          where rn <= ${perStory} limit ${limit}`;
        let found = 0;
        yield* Effect.forEach(
          todo,
          (row) =>
            Effect.gen(function* () {
              const res = yield* http.execute(HttpClientRequest.get(row.url).pipe(HttpClientRequest.setHeaders({ "user-agent": UA, accept: "text/html" })));
              const bytes = res.status >= 200 && res.status < 300 && /html/i.test(res.headers["content-type"] ?? "") ? yield* res.arrayBuffer.pipe(Effect.timeout("20 seconds")) : null;
              const x = bytes ? yield* extract(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, MAX_BYTES)), row.url) : null;
              if (x?.imageUrl) found++;
              yield* sql`update articles set image_url = ${x?.imageUrl ?? ""} where id = ${row.id}`;
            }).pipe(Effect.catch(() => sql`update articles set image_url = '' where id = ${row.id}`.pipe(Effect.orDie))),
          { concurrency: 16, discard: true },
        );
        return [todo.length, found] as const;
      }, Effect.orDie);

      const cleanLedes = Effect.gen(function* () {
        const rows = yield* sql<{ id: number; lede: string | null; body: string | null }>`select id, lede, body from articles where reject_reason is null and lede is not null`;
        let fixed = 0, rejected = 0;
        for (const r of rows) {
          if (!isBoilerplate(r.lede ?? "")) continue;
          const lede = cleanLede(null, r.body, LEDE_CHARS);
          if (lede) {
            yield* sql`update articles set lede = ${lede} where id = ${r.id}`;
            fixed++;
          } else {
            yield* sql`update articles set reject_reason = 'short' where id = ${r.id}`;
            rejected++;
          }
        }
        // embed_key = md5(title || lede) changed for the rows above, so their old vectors (and story membership) are orphans
        yield* sql`delete from embeddings e where not exists (select 1 from articles a where a.embed_key = e.embed_key)`;
        return [fixed, rejected] as const;
      }).pipe(Effect.orDie);

      const quality = Effect.gen(function* () {
        // Idempotent: undo earlier quality rejections first, so a tightened rule frees pages an older rule caught.
        yield* sql`update articles set reject_reason = null where reject_reason in ('press_release', 'roundup', 'listicle')`;
        const rows = yield* sql<{ id: number; title: string | null; lede: string | null; domain: string }>`select id, title, lede, domain from articles where reject_reason is null`;
        const hits = new Map<string, number[]>();
        for (const r of rows) {
          const why = lowQuality(r.title, r.lede, r.domain);
          if (why) (hits.get(why) ?? hits.set(why, []).get(why)!).push(Number(r.id));
        }
        for (const [why, ids] of hits) yield* sql`update articles set reject_reason = ${why} where id in ${sql.in(ids)}`;
        return Object.fromEntries([...hits].map(([why, ids]) => [why, ids.length]));
      }).pipe(Effect.orDie);

      return Backfill.of({ images, cleanLedes, quality });
    }),
  );
}
