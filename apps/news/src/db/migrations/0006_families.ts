import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Owner groups and consensus ratings.
//  outlets.n_sources / spread: how many rating sources agreed into this row, and the widest gap (in steps on the
//                              five-point scale) between them. spread >= 2 means the sources really disagree.
//  families: regex rules that put many domains of one owner or wire network into one group, so a story carried by
//            40 NPR stations counts one outlet. `inherit_from` lends an unrated member that domain's rating.
//            `unrated_only` rules never touch a domain that has its own rating.
//  resolve_domain(d): the one place that turns an article's domain into (name, bias, factuality, family).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table outlets add column if not exists n_sources int not null default 1`;
  yield* sql`alter table outlets add column if not exists spread int not null default 0`;
  yield* sql`
    create table if not exists families (
      pattern      text primary key,
      family       text not null,
      inherit_from text,
      unrated_only boolean not null default true,
      priority     int not null default 100
    )`;
  // news.l2.test -> {news.l2.test, l2.test}: parent domains, so a rating for the parent covers subdomains via the index
  yield* sql`
    create or replace function domain_suffixes(d text) returns text[] language sql immutable as $$
      select array(
        select array_to_string(p.parts[i:], '.')
        from (select string_to_array(d, '.') as parts) p, generate_series(1, greatest(array_length(p.parts, 1) - 1, 1)) as i)
    $$`;
  yield* sql`
    create or replace function resolve_domain(d text)
    returns table (name text, bias text, factuality text, family text, inherited boolean, contested boolean)
    language sql stable as $$
      select coalesce(o.name, d), coalesce(o.bias, i.bias), coalesce(o.factuality, i.factuality), f.family,
             (o.bias is null and i.bias is not null), coalesce(o.spread >= 2, false)
      from (select 1) x
      left join lateral (select * from outlets where outlets.domain = any (domain_suffixes(d)) order by length(outlets.domain) desc limit 1) o on true
      left join lateral (select * from families fa where d ~ fa.pattern and (not fa.unrated_only or o.bias is null) order by fa.priority, fa.pattern limit 1) f on true
      left join lateral (select * from outlets where outlets.domain = f.inherit_from and o.bias is null) i on true
    $$`;
});
