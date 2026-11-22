import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Social-share image of each article. null = never looked; '' = looked, the page has none (so a backfill skips it).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table articles add column if not exists image_url text`;
});
