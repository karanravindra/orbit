import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Outlet-level ratings. Matched to articles by domain (a rating for `bbc.co.uk` also covers `news.bbc.co.uk`).
// Bias is the usual five-point scale; factuality is optional. `source` records where a row came from
// (the bundled seed, or a CSV the operator imported) so it can be replaced wholesale.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists outlets (
      domain     text primary key,
      name       text not null,
      bias       text not null check (bias in ('left','lean-left','center','lean-right','right')),
      factuality text check (factuality in ('high','mixed','low')),
      country    text,
      source     text not null,
      updated_at timestamptz not null default now()
    )`;
});
