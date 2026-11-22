import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Classifier } from "../topics/Classifier";

const RECENT_DAYS = 14;
const TITLES = 5;

export interface TopicStats {
  readonly candidates: number;
  readonly classified: number;
  readonly failed: number;
}

/**
 * Files stories into sections. A story is a candidate when it is recent, covered by >= 3 domains, and either never
 * classified or at least twice the size it had when classified. Failures are skipped and retried next tick.
 */
export class Topics extends Context.Service<Topics, {
  run(opts?: { readonly all?: boolean; readonly limit?: number }): Effect.Effect<TopicStats>;
}>()("news/pipeline/Topics") {
  static readonly layer = Layer.effect(
    Topics,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const classifier = yield* Classifier;

      const run = Effect.fn("Topics.run")(function* (opts?: { readonly all?: boolean; readonly limit?: number }) {
        const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
        const rows = yield* sql<{ id: number; texts: number; headline: string; titles: string[] }>`
          with c as (
            select g.id, g.centroid, (select count(*)::int from story_texts t where t.story_id = g.id) as texts
            from stories g
            where g.last_seen >= ${since}
              and (select count(distinct a.domain) from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                   where t.story_id = g.id) >= 3
              and (${opts?.all ?? false} or g.topic is null or (select count(*) from story_texts t where t.story_id = g.id) >= 2 * coalesce(g.topic_texts, 1)))
          select c.id, c.texts,
                 (select a.title from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                    join embeddings e on e.embed_key = t.embed_key where t.story_id = c.id order by e.cvec <=> c.centroid limit 1) as headline,
                 coalesce((select array_agg(x.title) from (
                    select distinct on (a.domain) a.title, e.cvec <=> c.centroid as d
                    from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                    join embeddings e on e.embed_key = t.embed_key where t.story_id = c.id
                    order by a.domain, d limit 40) x), '{}') as titles
          from c order by c.texts desc limit ${opts?.limit ?? 500}`.pipe(Effect.orDie);

        let classified = 0;
        let failed = 0;
        yield* Effect.forEach(
          rows,
          (r) => {
            const others = r.titles.filter((t) => t !== r.headline).slice(0, TITLES);
            return classifier.classify(r.headline, others).pipe(
              Effect.flatMap((topic) => sql`update stories set topic = ${topic}, topic_texts = ${r.texts} where id = ${r.id}`.pipe(Effect.orDie)),
              Effect.tap(() => Effect.sync(() => void classified++)),
              Effect.catch((e) => Effect.logWarning(`topic for story ${r.id} failed: ${e.message}`).pipe(Effect.tap(() => Effect.sync(() => void failed++)))),
            );
          },
          { concurrency: 4, discard: true },
        );
        return { candidates: rows.length, classified, failed } satisfies TopicStats;
      });

      return Topics.of({ run });
    }),
  );
}
