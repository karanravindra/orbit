import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { Extracted } from "../extract/extract";
import type { UrlJob } from "./Urls";

/** The `articles` table. DB failures are defects. */
export class Articles extends Context.Service<Articles, {
  /** Store the extracted page and mark its queue row `ok`, atomically. */
  save(job: UrlJob, x: Extracted): Effect.Effect<void>;
}>()("news/repos/Articles") {
  static readonly layer = Layer.effect(
    Articles,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const save = Effect.fn("Articles.save")(function* (job: UrlJob, x: Extracted) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into articles (url, domain, sitename, title, lede, body, title_key, text_hash, seen_at, published_at, reject_reason)
              values (${job.url}, ${job.domain}, ${x.sitename}, ${x.title}, ${x.lede}, ${x.body}, ${x.titleKey}, ${x.textHash}, ${job.seenAt}, ${x.publishedAt}, ${x.rejectReason})
              on conflict (url) do nothing`;
            yield* sql`update urls set fetch_status = 'ok', last_status = ${x.rejectReason ?? "ok"}, updated_at = now() where url = ${job.url}`;
          }),
        );
      }, Effect.orDie);

      return Articles.of({ save });
    }),
  );
}
