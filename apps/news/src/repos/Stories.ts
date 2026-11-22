import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { fromPg, toPg } from "../cluster/vec";

/** A distinct text (one embedding) with when and where it was published. */
export interface Text {
  readonly embedKey: string;
  readonly vec: Float32Array;
  readonly firstSeen: Date;
  readonly domains: ReadonlyArray<string>;
}
export interface Neighbour extends Text {
  readonly sim: number;
}
export interface Near {
  readonly id: number;
  readonly sim: number;
  readonly n: number;
  readonly centroid: Float32Array;
}
export interface StoryRow {
  readonly id: number;
  readonly n: number;
  readonly centroid: Float32Array;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}
export interface MergePair {
  readonly a: number;
  readonly b: number;
  readonly sim: number;
}
export interface Overview {
  readonly texts: number;
  readonly considered: number;
  readonly assigned: number;
  readonly stories: number;
  readonly shown: number;
  readonly shownArticles: number;
}
export interface TopStory {
  readonly storyId: number;
  readonly outlets: number;
  readonly texts: number;
  readonly articles: number;
  readonly minSim: number;
  readonly avgSim: number;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly headline: string;
}
export interface SampleArticle {
  readonly domain: string;
  readonly title: string;
  readonly sim: number;
}

type RawText = { embedKey: string; vec: string; firstSeen: Date; domains: string[] };
const toText = (r: RawText): Text => ({ embedKey: r.embedKey, vec: fromPg(r.vec), firstSeen: r.firstSeen, domains: r.domains });

/** Story state in Postgres/pgvector. DB failures are defects. */
export class Stories extends Context.Service<Stories, {
  /** Version of the frozen corpus mean the embeddings are centred on (0 = none yet). */
  meanVersion: Effect.Effect<number>;
  /** Stories built on an older mean; they must be rebuilt. */
  staleStories: Effect.Effect<number>;
  /** Serialise clustering runs and tune HNSW for filtered scans. Call at the start of a transaction. */
  begin: Effect.Effect<void>;
  /** Centred, embedded texts not yet considered, oldest first. */
  fresh(limit: number): Effect.Effect<ReadonlyArray<Text>>;
  /** Nearest live story whose time span is within `gapMs` of `seenAt`. */
  nearest(vec: Float32Array, seenAt: Date, gapMs: number): Effect.Effect<Option.Option<Near>>;
  /** Nearest texts not in any story. */
  neighbours(key: string, vec: Float32Array, k: number): Effect.Effect<ReadonlyArray<Neighbour>>;
  join(storyId: number, key: string, sim: number, centroid: Float32Array, n: number, seenAt: Date): Effect.Effect<void>;
  create(members: ReadonlyArray<{ readonly key: string; readonly sim: number }>, centroid: Float32Array, firstSeen: Date, lastSeen: Date, meanVersion: number): Effect.Effect<number>;
  markSeen(keys: ReadonlyArray<string>): Effect.Effect<void>;
  /** For each touched story, its nearest other story if at least `minSim` similar and overlapping in time. */
  mergeTargets(ids: ReadonlyArray<number>, minSim: number, gapMs: number): Effect.Effect<ReadonlyArray<MergePair>>;
  story(id: number): Effect.Effect<StoryRow>;
  /** Fold `drop` into `keep`. */
  merge(keep: StoryRow, drop: StoryRow): Effect.Effect<void>;
  reset: Effect.Effect<void>;
  // ---- inspection ----
  overview(minOutlets: number): Effect.Effect<Overview>;
  top(limit: number, minOutlets: number): Effect.Effect<ReadonlyArray<TopStory>>;
  sample(storyId: number, n: number): Effect.Effect<ReadonlyArray<SampleArticle>>;
  /** Percentiles (5/25/50/75/95) of text→centroid similarity and of nearest centroid→centroid similarity. */
  simStats: Effect.Effect<{ textToCentroid: ReadonlyArray<number>; centroidToCentroid: ReadonlyArray<number> }>;
  sizeHistogram: Effect.Effect<ReadonlyArray<{ bucket: string; stories: number }>>;
}>()("news/repos/Stories") {
  static readonly layer = Layer.effect(
    Stories,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);

      const meanVersion = die(sql<{ v: number | null }>`select mean_version as v from embedding_state where id = 1`.pipe(Effect.map((r) => r[0]?.v ?? 0)));
      const staleStories = die(sql<{ n: number }>`select count(*)::int as n from stories where mean_version <> coalesce((select mean_version from embedding_state where id = 1), 0)`.pipe(Effect.map((r) => r[0]!.n)));

      const begin = die(
        Effect.gen(function* () {
          yield* sql`select pg_advisory_xact_lock(hashtext('news:cluster'))`;
          // pgvector >= 0.8: keep scanning the HNSW graph until enough rows pass the WHERE filters.
          yield* sql`set local hnsw.iterative_scan = relaxed_order`;
          yield* sql`set local hnsw.ef_search = 100`;
        }),
      );

      const fresh = Effect.fn("Stories.fresh")(function* (limit: number) {
        const rows = yield* sql<RawText>`
          with m as (
            select embed_key, min(seen_at) as first_seen, array_agg(distinct domain) as domains
            from articles where reject_reason is null and embed_key is not null group by embed_key)
          select e.embed_key, e.cvec::text as vec, m.first_seen, m.domains
          from embeddings e join m on m.embed_key = e.embed_key
          where e.cvec is not null and not exists (select 1 from cluster_seen c where c.embed_key = e.embed_key)
          order by m.first_seen, e.embed_key
          limit ${limit}`;
        return rows.map(toText);
      }, die);

      const nearest = Effect.fn("Stories.nearest")(function* (vec: Float32Array, seenAt: Date, gapMs: number) {
        const v = toPg(vec);
        const rows = yield* sql<{ id: number; sim: number; n: number; centroid: string }>`
          select id, 1 - (centroid <=> ${v}::vector) as sim, n, centroid::text as centroid
          from stories
          where last_seen >= ${new Date(+seenAt - gapMs)} and first_seen <= ${new Date(+seenAt + gapMs)}
            and mean_version = coalesce((select mean_version from embedding_state where id = 1), 0)
          order by centroid <=> ${v}::vector limit 1`;
        return Option.fromNullishOr(rows[0]).pipe(Option.map((r): Near => ({ id: Number(r.id), sim: r.sim, n: r.n, centroid: fromPg(r.centroid) })));
      }, die);

      const neighbours = Effect.fn("Stories.neighbours")(function* (key: string, vec: Float32Array, k: number) {
        const v = toPg(vec);
        const rows = yield* sql<RawText & { sim: number }>`
          with nn as (
            select e.embed_key, 1 - (e.cvec <=> ${v}::vector) as sim, e.cvec::text as vec
            from embeddings e
            where e.cvec is not null and e.embed_key <> ${key}
              and not exists (select 1 from story_texts st where st.embed_key = e.embed_key)
            order by e.cvec <=> ${v}::vector limit ${k})
          select nn.embed_key, nn.sim, nn.vec, m.first_seen, m.domains
          from nn join (
            select embed_key, min(seen_at) as first_seen, array_agg(distinct domain) as domains
            from articles where reject_reason is null and embed_key in (select embed_key from nn) group by embed_key) m
            on m.embed_key = nn.embed_key
          order by nn.sim desc`;
        return rows.map((r): Neighbour => ({ ...toText(r), sim: r.sim }));
      }, die);

      const join = Effect.fn("Stories.join")(function* (storyId: number, key: string, sim: number, centroid: Float32Array, n: number, seenAt: Date) {
        yield* sql`
          update stories set centroid = ${toPg(centroid)}::vector, n = ${n},
            last_seen = greatest(last_seen, ${seenAt}), first_seen = least(first_seen, ${seenAt}), updated_at = now()
          where id = ${storyId}`;
        yield* sql`insert into story_texts (embed_key, story_id, sim) values (${key}, ${storyId}, ${sim})`;
      }, die);

      const create = Effect.fn("Stories.create")(function* (members: ReadonlyArray<{ readonly key: string; readonly sim: number }>, centroid: Float32Array, firstSeen: Date, lastSeen: Date, meanVersion: number) {
        const [row] = yield* sql<{ id: number }>`
          insert into stories (centroid, n, first_seen, last_seen, mean_version)
          values (${toPg(centroid)}::vector, ${members.length}, ${firstSeen}, ${lastSeen}, ${meanVersion}) returning id`;
        const id = Number(row!.id);
        const json = JSON.stringify(members.map((m) => ({ k: m.key, s: m.sim })));
        yield* sql`
          insert into story_texts (embed_key, story_id, sim)
          select r.k, ${id}, r.s from json_to_recordset(${json}::json) as r(k text, s real)`;
        return id;
      }, die);

      const markSeen = Effect.fn("Stories.markSeen")(function* (keys: ReadonlyArray<string>) {
        if (keys.length === 0) return;
        const json = JSON.stringify(keys);
        yield* sql`insert into cluster_seen (embed_key) select value from json_array_elements_text(${json}::json) on conflict do nothing`;
      }, die);

      const mergeTargets = Effect.fn("Stories.mergeTargets")(function* (ids: ReadonlyArray<number>, minSim: number, gapMs: number) {
        if (ids.length === 0) return [] as ReadonlyArray<MergePair>;
        const gap = `${Math.round(gapMs / 1000)} seconds`;
        const rows = yield* sql<{ a: number; b: number; sim: number }>`
          select a.id as a, b.id as b, 1 - (a.centroid <=> b.centroid) as sim
          from stories a
          join lateral (
            select s.id, s.centroid from stories s
            where s.id <> a.id and s.mean_version = a.mean_version
              and s.last_seen >= a.first_seen - ${gap}::interval and s.first_seen <= a.last_seen + ${gap}::interval
            order by s.centroid <=> a.centroid limit 1) b on true
          where a.id in ${sql.in(ids as number[])} and 1 - (a.centroid <=> b.centroid) >= ${minSim}
          order by sim desc`;
        return rows.map((r): MergePair => ({ a: Number(r.a), b: Number(r.b), sim: r.sim }));
      }, die);

      const story = Effect.fn("Stories.story")(function* (id: number) {
        const [r] = yield* sql<{ id: number; n: number; centroid: string; firstSeen: Date; lastSeen: Date }>`select id, n, centroid::text as centroid, first_seen, last_seen from stories where id = ${id}`;
        return { id: Number(r!.id), n: r!.n, centroid: fromPg(r!.centroid), firstSeen: r!.firstSeen, lastSeen: r!.lastSeen } as StoryRow;
      }, die);

      const merge = Effect.fn("Stories.merge")(function* (keep: StoryRow, drop: StoryRow) {
        const c = new Float32Array(keep.centroid.length);
        for (let i = 0; i < c.length; i++) c[i] = keep.centroid[i]! * keep.n + drop.centroid[i]! * drop.n;
        let s = 0;
        for (const x of c) s += x * x;
        const norm = Math.sqrt(s) || 1;
        for (let i = 0; i < c.length; i++) c[i]! /= norm;
        yield* sql`update story_texts set story_id = ${keep.id} where story_id = ${drop.id}`;
        yield* sql`
          update stories set centroid = ${toPg(c)}::vector, n = ${keep.n + drop.n},
            first_seen = least(first_seen, ${drop.firstSeen}), last_seen = greatest(last_seen, ${drop.lastSeen}), updated_at = now()
          where id = ${keep.id}`;
        yield* sql`delete from stories where id = ${drop.id}`;
      }, die);

      const reset = die(sql`truncate stories, story_texts, cluster_seen restart identity cascade`.pipe(Effect.asVoid));

      const overview = Effect.fn("Stories.overview")(function* (minOutlets: number) {
        const [r] = yield* sql<Overview>`
          select (select count(*)::int from embeddings where cvec is not null) as texts,
                 (select count(*)::int from cluster_seen) as considered,
                 (select count(*)::int from story_texts) as assigned,
                 (select count(*)::int from stories) as stories,
                 (select count(*)::int from (
                    select st.story_id from story_texts st join articles a on a.embed_key = st.embed_key and a.reject_reason is null
                    group by st.story_id having count(distinct a.domain) >= ${minOutlets}) x) as shown,
                 (select count(*)::int from articles a join story_texts st on st.embed_key = a.embed_key
                    where a.reject_reason is null and st.story_id in (
                      select st2.story_id from story_texts st2 join articles a2 on a2.embed_key = st2.embed_key and a2.reject_reason is null
                      group by st2.story_id having count(distinct a2.domain) >= ${minOutlets})) as shown_articles`;
        return r!;
      }, die);

      const top = Effect.fn("Stories.top")(function* (limit: number, minOutlets: number) {
        const rows = yield* sql<TopStory>`
          with s as (
            select st.story_id, count(distinct a.domain)::int as outlets, count(distinct st.embed_key)::int as texts, count(a.id)::int as articles,
                   min(st.sim)::float8 as min_sim, avg(st.sim)::float8 as avg_sim
            from story_texts st join articles a on a.embed_key = st.embed_key and a.reject_reason is null
            group by st.story_id)
          select s.story_id, s.outlets, s.texts, s.articles, s.min_sim, s.avg_sim, g.first_seen, g.last_seen,
                 (select a.title from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                    join embeddings e on e.embed_key = t.embed_key
                    where t.story_id = s.story_id order by e.cvec <=> g.centroid limit 1) as headline
          from s join stories g on g.id = s.story_id
          where s.outlets >= ${minOutlets}
          order by s.outlets desc, s.articles desc limit ${limit}`;
        return rows as ReadonlyArray<TopStory>;
      }, die);

      const sample = Effect.fn("Stories.sample")(function* (storyId: number, n: number) {
        const rows = yield* sql<SampleArticle>`
          select distinct on (a.domain) a.domain, a.title, 1 - (e.cvec <=> g.centroid) as sim
          from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
            join embeddings e on e.embed_key = t.embed_key join stories g on g.id = t.story_id
          where t.story_id = ${storyId}
          order by a.domain, e.cvec <=> g.centroid`;
        return [...rows].sort((x, y) => y.sim - x.sim).slice(0, n);
      }, die);

      const simStats = die(
        Effect.gen(function* () {
          const [t] = yield* sql<{ p: number[] | null }>`select percentile_cont(array[0.05, 0.25, 0.5, 0.75, 0.95]) within group (order by sim) as p from story_texts`;
          const [c] = yield* sql<{ p: number[] | null }>`
            select percentile_cont(array[0.05, 0.25, 0.5, 0.75, 0.95]) within group (order by sim) as p from (
              select 1 - (a.centroid <=> b.centroid) as sim from stories a
              join lateral (select s.centroid from stories s where s.id <> a.id order by s.centroid <=> a.centroid limit 1) b on true) x`;
          return { textToCentroid: t?.p ?? [], centroidToCentroid: c?.p ?? [] };
        }),
      );

      const sizeHistogram = die(
        sql<{ bucket: string; stories: number }>`
          select case when texts = 1 then '1' when texts = 2 then '2' when texts <= 4 then '3-4' when texts <= 9 then '5-9' when texts <= 24 then '10-24' else '25+' end as bucket, count(*)::int as stories
          from (select story_id, count(*) as texts from story_texts group by story_id) x
          group by 1 order by min(texts)`,
      );

      return Stories.of({ meanVersion, staleStories, begin, fresh, nearest, neighbours, join, create, markSeen, mergeTargets, story, merge, reset, overview, top, sample, simStats, sizeHistogram });
    }),
  );
}
