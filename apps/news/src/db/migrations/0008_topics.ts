import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A story's section. topic_texts is the story's size when it was classified: a story that doubles is classified again,
// because its headline and member titles have changed. topic null = not yet classified.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table stories add column if not exists topic text`;
  yield* sql`alter table stories add column if not exists topic_texts int`;
  yield* sql`create index if not exists stories_topic on stories (topic)`;
});
