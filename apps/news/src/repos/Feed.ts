import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";
import { cleanLede } from "../extract/extract";
import { blindspot, type BiasCounts } from "../outlets/bias";

export interface StorySummary {
  readonly id: number;
  readonly headline: string;
  /** Most common usable share image among the story's articles. */
  readonly image: string | null;
  /** Distinct owner groups covering the story (the unit of coverage). */
  readonly outlets: number;
  readonly articles: number;
  /** Distinct texts: syndicated copies count once. */
  readonly texts: number;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly bias: BiasCounts;
  readonly blindspot: "left" | "right" | null;
}
export interface StoryArticle {
  readonly url: string;
  readonly image: string | null;
  readonly title: string;
  readonly lede: string | null;
  readonly domain: string;
  readonly outlet: string;
  readonly bias: string | null;
  readonly factuality: string | null;
  /** Owner group (e.g. NPR member stations), if any. */
  readonly family: string | null;
  /** True when the rating is borrowed from the group's parent rather than the outlet itself. */
  readonly inherited: boolean;
  /** True when rating sources disagreed by two or more steps. */
  readonly contested: boolean;
  readonly seenAt: Date;
}
export interface StoryDetail extends StorySummary {
  readonly sources: ReadonlyArray<StoryArticle>;
}
export type Sort = "coverage" | "recent";

type RawSummary = Omit<StorySummary, "bias" | "blindspot"> & {
  left: number; leanLeft: number; center: number; leanRight: number; right: number; unrated: number;
};
// A blindspot needs at least this many distinct texts: one wire story copied across many outlets says little.
const MIN_BLINDSPOT_TEXTS = 4;
const withBias = (r: RawSummary): StorySummary => {
  const bias: BiasCounts = { left: r.left, leanLeft: r.leanLeft, center: r.center, leanRight: r.leanRight, right: r.right, unrated: r.unrated };
  const { left: _l, leanLeft: _ll, center: _c, leanRight: _lr, right: _r, unrated: _u, ...rest } = r;
  return { ...rest, id: Number(r.id), bias, blindspot: r.texts >= MIN_BLINDSPOT_TEXTS ? blindspot(bias) : null };
};

/** Read model for the API: stories with their outlet bias spread. DB failures are defects. */
export class Feed extends Context.Service<Feed, {
  /** Stories updated within the last `hours`. */
  list(opts: { readonly limit: number; readonly minOutlets: number; readonly sort: Sort; readonly hours: number; readonly blindspotOnly?: boolean }): Effect.Effect<ReadonlyArray<StorySummary>>;
  get(id: number): Effect.Effect<Option.Option<StoryDetail>>;
}>()("news/Feed") {
  static readonly layer = Layer.effect(
    Feed,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);

      // Coverage is counted per owner group: a story carried by 40 NPR stations is one outlet, not forty.
      // The pool is picked on raw domain counts (cheap), then regrouped by owner and re-ranked in TypeScript.
      const summaries = (storyFilter: Fragment, inner: Fragment, pool: number) => sql<RawSummary>`
        with st as (
          select t.story_id, a.domain, count(*)::int as n
          from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
          group by t.story_id, a.domain),
        s as (
          select story_id, count(*)::int as raw_outlets, sum(n)::int as articles
          from st group by story_id),
        picked as (
          select s.story_id, s.articles, g.first_seen, g.last_seen, g.centroid
          from s join stories g on g.id = s.story_id
          where ${storyFilter}
          order by ${inner} limit ${pool}),
        rs as (
          select p.story_id, st.domain, coalesce(r.family, st.domain) as owner, r.bias
          from picked p join st on st.story_id = p.story_id
          left join lateral resolve_domain(st.domain) r on true),
        b as (
          select story_id, owner, (array_agg(bias order by bias is null, bias))[1] as bias
          from rs group by story_id, owner)
        select p.story_id as id, p.articles, p.first_seen, p.last_seen,
               (select count(*) from story_texts t where t.story_id = p.story_id)::int as texts,
               (select a.title from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                  join embeddings e on e.embed_key = t.embed_key
                  where t.story_id = p.story_id order by e.cvec <=> p.centroid limit 1) as headline,
               (select a.image_url from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
                  where t.story_id = p.story_id and a.image_url ~ '^https?://' and a.image_url !~* '(logo|favicon|placeholder|default|sprite|avatar|blank)'
                  group by a.image_url order by count(*) desc, length(a.image_url) limit 1) as image,
               (select count(*) from b where b.story_id = p.story_id)::int as outlets,
               (select count(*) from b where b.story_id = p.story_id and b.bias = 'left')::int as "left",
               (select count(*) from b where b.story_id = p.story_id and b.bias = 'lean-left')::int as lean_left,
               (select count(*) from b where b.story_id = p.story_id and b.bias = 'center')::int as "center",
               (select count(*) from b where b.story_id = p.story_id and b.bias = 'lean-right')::int as lean_right,
               (select count(*) from b where b.story_id = p.story_id and b.bias = 'right')::int as "right",
               (select count(*) from b where b.story_id = p.story_id and b.bias is null)::int as unrated
        from picked p`;

      const list = Effect.fn("Feed.list")(function* (opts: { limit: number; minOutlets: number; sort: Sort; hours: number; blindspotOnly?: boolean }) {
        const inner = opts.sort === "recent" ? sql`g.last_seen desc, s.raw_outlets desc` : sql`s.raw_outlets desc, g.last_seen desc`;
        // Owner grouping and blindspots are decided after scoring, so look at a wider candidate pool first.
        const pool = Math.max(opts.limit * (opts.blindspotOnly ? 10 : 3), 200);
        const since = new Date(Date.now() - opts.hours * 3_600_000);
        const rows = yield* summaries(sql`s.raw_outlets >= ${opts.minOutlets} and g.last_seen >= ${since}`, inner, pool);
        const out = rows.map(withBias).filter((r) => r.outlets >= opts.minOutlets && (!opts.blindspotOnly || r.blindspot !== null));
        out.sort(opts.sort === "recent" ? (a, b) => +b.lastSeen - +a.lastSeen || b.outlets - a.outlets : (a, b) => b.outlets - a.outlets || +b.lastSeen - +a.lastSeen);
        return out.slice(0, opts.limit);
      }, die);

      const get = Effect.fn("Feed.get")(function* (id: number) {
        const rows = yield* summaries(sql`s.story_id = ${id}`, sql`s.raw_outlets desc`, 1);
        const head = rows[0];
        if (!head) return Option.none<StoryDetail>();
        const arts = yield* sql<StoryArticle & { body: string | null }>`
          select distinct on (a.url) a.url, a.title, a.lede, left(a.body, 3000) as body, a.image_url as image, a.domain, r.name as outlet,
                 r.bias, r.factuality, r.family, r.inherited, r.contested, a.seen_at
          from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
          left join lateral resolve_domain(a.domain) r on true
          where t.story_id = ${id}`;
        const sorted = [...arts].map(({ body, ...a }) => ({ ...a, lede: cleanLede(a.lede, body) })).sort((x, y) => +x.seenAt - +y.seenAt);
        return Option.some<StoryDetail>({ ...withBias(head), sources: sorted });
      }, die);

      return Feed.of({ list, get });
    }),
  );
}
