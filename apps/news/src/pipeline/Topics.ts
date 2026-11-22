import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { cleanTitle } from "../extract/headline";
import { Classifier } from "../topics/Classifier";
import type { TopicId } from "../topics/taxonomy";

const RECENT_DAYS = 14;
const TITLES = 5;

export interface TopicStats {
  readonly candidates: number;
  readonly inherited: number;
  readonly classified: number;
  /** A disagreeing answer parked until a second one confirms it. */
  readonly pending: number;
  readonly failed: number;
}

/** What the classifier sees for one story, plus the text keys it is built from (votes are stored against them). */
export interface TopicInput {
  readonly id: number;
  readonly texts: number;
  readonly topic: string | null;
  readonly pending: string | null;
  readonly headline: string;
  readonly headlineKey: string;
  readonly titles: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}

type Row = {
  id: number; texts: number; topic: string | null; topicPending: string | null;
  head: { k: string; t: string; s: string | null; d: string } | null;
  others: Array<{ k: string; t: string; s: string | null; d: string }> | null;
};

/**
 * Files stories into sections. A story is a candidate when it is recent, covered by >= 3 domains, and either never
 * classified or at least twice the size it had when classified.
 *
 * Votes live on texts (`text_topics`, keyed by embed_key), not on story ids, so `cluster --rebuild` and merges do not
 * lose work: a story with no section first inherits the plurality of its members' votes without calling the model.
 * A later answer that disagrees with the current section is parked (`topic_pending`); only a second agreeing answer
 * flips it, so one noisy call cannot move a story between rows.
 */
export class Topics extends Context.Service<Topics, {
  run(opts?: { readonly all?: boolean; readonly limit?: number }): Effect.Effect<TopicStats>;
  /** Classifier inputs for recent multi-outlet stories; `where` narrows to unclassified/grown ones, `random` samples. */
  inputs(opts: { readonly all: boolean; readonly limit: number; readonly random?: boolean; readonly days?: number }): Effect.Effect<ReadonlyArray<TopicInput>>;
}>()("news/pipeline/Topics") {
  static readonly layer = Layer.effect(
    Topics,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const classifier = yield* Classifier;

      const inputs = Effect.fn("Topics.inputs")(function* (opts: { all: boolean; limit: number; random?: boolean; days?: number }) {
        const since = new Date(Date.now() - (opts.days ?? RECENT_DAYS) * 86_400_000);
        const rows = yield* sql<Row>`
          with c as (
            select g.id, g.centroid, g.topic, g.topic_pending, (select count(*)::int from story_texts t where t.story_id = g.id) as texts
            from stories g
            where g.last_seen >= ${since}
              and (select count(distinct a.domain) from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                   where t.story_id = g.id) >= 3
              and (${opts.all} or g.topic is null or (select count(*) from story_texts t where t.story_id = g.id) >= 2 * coalesce(g.topic_texts, 1)))
          select c.id, c.texts, c.topic, c.topic_pending,
                 (select json_build_object('k', e.embed_key, 't', a.title, 's', a.sitename, 'd', a.domain)
                    from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                    join embeddings e on e.embed_key = t.embed_key where t.story_id = c.id order by e.cvec <=> c.centroid limit 1) as head,
                 (select json_agg(json_build_object('k', x.embed_key, 't', x.title, 's', x.sitename, 'd', x.domain) order by x.dist) from (
                    select distinct on (a.domain) e.embed_key, a.title, a.sitename, a.domain, e.cvec <=> c.centroid as dist
                    from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                    join embeddings e on e.embed_key = t.embed_key where t.story_id = c.id
                    order by a.domain, dist limit 40) x) as others
          from c order by ${opts.random ? sql`random()` : sql`c.texts desc`} limit ${opts.limit}`.pipe(Effect.orDie);

        return rows.flatMap((r): TopicInput[] => {
          if (!r.head) return [];
          const clean = (x: { t: string; s: string | null; d: string }) => cleanTitle(x.t, x.s, x.d);
          const headline = clean(r.head);
          const seen = new Set([headline]);
          const others = (r.others ?? []).filter((o) => o.k !== r.head!.k && !seen.has(clean(o)) && seen.add(clean(o))).slice(0, TITLES);
          return [{ id: Number(r.id), texts: r.texts, topic: r.topic, pending: r.topicPending, headline, headlineKey: r.head.k, titles: others.map(clean), keys: others.map((o) => o.k) }];
        });
      });

      /** Rebuilt or merged stories: take the plurality section of their members' votes (>= 2 votes, >= 60% of all votes). */
      const inherit = sql`
        with v as (
          select t.story_id, tt.topic, count(*)::int as c
          from stories g join story_texts t on t.story_id = g.id join text_topics tt on tt.embed_key = t.embed_key
          where g.topic is null group by 1, 2),
        w as (
          select story_id, topic, c, sum(c) over (partition by story_id) as tot,
                 row_number() over (partition by story_id order by c desc, topic) as rn
          from v)
        update stories g set topic = w.topic, topic_texts = (select count(*)::int from story_texts t where t.story_id = g.id)
        from w where w.story_id = g.id and w.rn = 1 and w.c >= 2 and w.c >= 0.6 * w.tot
        returning g.id`.pipe(Effect.map((r) => r.length), Effect.orDie);

      const vote = (topic: string, keys: ReadonlyArray<string>) =>
        sql`insert into text_topics (embed_key, topic) select value, ${topic} from json_array_elements_text(${JSON.stringify(keys)}::json)
            on conflict (embed_key) do update set topic = excluded.topic, voted_at = now()`.pipe(Effect.orDie);

      /** Apply one classifier answer under the two-vote rule. Returns the section the story ends up in and whether it was parked. */
      const apply = (r: TopicInput, answer: TopicId, force: boolean) =>
        Effect.gen(function* () {
          const keys = [r.headlineKey, ...r.keys];
          if (r.topic === null || r.topic === answer || force || r.pending === answer) {
            yield* sql`update stories set topic = ${answer}, topic_texts = ${r.texts}, topic_pending = null where id = ${r.id}`.pipe(Effect.orDie);
            yield* vote(answer, keys);
            return false;
          }
          yield* sql`update stories set topic_pending = ${answer}, topic_texts = ${r.texts} where id = ${r.id}`.pipe(Effect.orDie);
          return true;
        });

      const run = Effect.fn("Topics.run")(function* (opts?: { readonly all?: boolean; readonly limit?: number }) {
        const inherited = yield* inherit;
        const rows = yield* inputs({ all: opts?.all ?? false, limit: opts?.limit ?? 500 });
        let classified = 0, pending = 0, failed = 0;
        yield* Effect.forEach(
          rows,
          (r) =>
            classifier.classify(r.headline, r.titles).pipe(
              Effect.flatMap((topic) => apply(r, topic, opts?.all ?? false)),
              Effect.tap((parked) => Effect.sync(() => void (parked ? pending++ : classified++))),
              Effect.catch((e) => Effect.logWarning(`topic for story ${r.id} failed: ${e.message}`).pipe(Effect.tap(() => Effect.sync(() => void failed++)))),
            ),
          { concurrency: 4, discard: true },
        );
        return { candidates: rows.length, inherited, classified, pending, failed } satisfies TopicStats;
      });

      return Topics.of({ run, inputs });
    }),
  );
}
