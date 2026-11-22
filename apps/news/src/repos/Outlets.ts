import { Context, Effect, Layer } from "effect";
import * as Arr from "effect/Array";
import { SqlClient } from "effect/sql";
import type { OutletRow } from "../outlets/csv";
import type { FamilyRule } from "../outlets/consensus";

export interface Coverage {
  readonly rated: number;
  readonly total: number;
  readonly articlesRated: number;
  readonly articlesTotal: number;
}

/** Outlet ratings. DB failures are defects. */
export class Outlets extends Context.Service<Outlets, {
  /** Replace every row from `source` with `rows` (rows from other sources are kept; same domain is overwritten). */
  replace(source: string, rows: ReadonlyArray<OutletRow>, spreads?: ReadonlyMap<string, number>): Effect.Effect<number>;
  /** Replace all owner-group rules. */
  setFamilies(rules: ReadonlyArray<FamilyRule>): Effect.Effect<number>;
  /** How many of the outlets (and articles) we have collected are rated. */
  coverage: Effect.Effect<Coverage>;
  /** Unrated outlets that appear in the most shown stories, to decide what to rate next. */
  unrated(limit: number, minOutlets: number): Effect.Effect<ReadonlyArray<{ readonly domain: string; readonly stories: number }>>;
}>()("news/Outlets") {
  static readonly layer = Layer.effect(
    Outlets,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);

      const replace = Effect.fn("Outlets.replace")(function* (source: string, rows: ReadonlyArray<OutletRow>, spreads: ReadonlyMap<string, number> = new Map()) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`delete from outlets where source = ${source}`;
            for (const chunk of Arr.chunksOf(rows, 500)) {
              yield* sql`
                insert into outlets (domain, name, bias, factuality, country, spread, n_sources, source)
                select domain, name, bias, factuality, country, spread, n_sources, ${source}
                from json_to_recordset(${JSON.stringify(chunk.map((r) => ({ ...r, spread: spreads.get(r.domain) ?? 0, n_sources: spreads.has(r.domain) ? 2 : 1 })))}::json) as r(domain text, name text, bias text, factuality text, country text, spread int, n_sources int)
                on conflict (domain) do update set name = excluded.name, bias = excluded.bias, factuality = excluded.factuality,
                  country = excluded.country, spread = excluded.spread, n_sources = excluded.n_sources, source = excluded.source, updated_at = now()`;
            }
          }),
        );
        return rows.length;
      }, die);

      const setFamilies = Effect.fn("Outlets.setFamilies")(function* (rules: ReadonlyArray<FamilyRule>) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`delete from families`;
            if (rules.length === 0) return;
            yield* sql`
              insert into families (pattern, family, inherit_from, unrated_only, priority)
              select pattern, family, inherit_from, unrated_only, priority
              from json_to_recordset(${JSON.stringify(rules.map((r) => ({ pattern: r.pattern, family: r.family, inherit_from: r.inheritFrom, unrated_only: r.unratedOnly, priority: r.priority })))}::json)
                as r(pattern text, family text, inherit_from text, unrated_only boolean, priority int)`;
          }),
        );
        return rules.length;
      }, die);

      const coverage = die(
        Effect.gen(function* () {
          const [r] = yield* sql<Coverage>`
            with d as (select domain, count(*)::int as n from articles where reject_reason is null group by domain),
            m as (select d.domain, d.n, (select bias is not null from resolve_domain(d.domain)) as rated from d)
            select count(*) filter (where rated)::int as rated, count(*)::int as total,
                   coalesce(sum(n) filter (where rated), 0)::int as articles_rated, coalesce(sum(n), 0)::int as articles_total
            from m`;
          return r!;
        }),
      );

      // Ranked by how many multi-outlet stories an owner group appears in: rating these is what fills the bias bars.
      const unrated = Effect.fn("Outlets.unrated")(function* (limit: number, minOutlets: number) {
        return yield* sql<{ domain: string; stories: number }>`
          with s as (
            select t.story_id, a.domain from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null
            group by t.story_id, a.domain),
          shown as (select story_id from s group by story_id having count(*) >= ${minOutlets})
          select s.domain, count(*)::int as stories from s join shown using (story_id)
          where (select bias is null from resolve_domain(s.domain))
          group by s.domain order by stories desc limit ${limit}`;
      }, die);

      return Outlets.of({ replace, setFamilies, coverage, unrated });
    }),
  );
}
