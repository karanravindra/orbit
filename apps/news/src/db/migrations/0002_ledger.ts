import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// BullMQ now owns leasing, attempts and backoff. `urls` is only a ledger: pending -> ok | failed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`update urls set fetch_status = 'pending' where fetch_status = 'retry'`;
  yield* sql`drop index if exists urls_queue`;
  yield* sql`alter table urls drop column if exists leased_until, drop column if exists next_attempt_at, drop column if exists attempts`;
  // Requeue pages through this index (md5 order interleaves domains).
  yield* sql`create index if not exists urls_unfinished on urls ((md5(url) collate "C")) where fetch_status in ('pending', 'retry')`;
});
