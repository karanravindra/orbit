import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// indep / indep_texts: independent reports among a story's texts (wire copies folded together) and the story's size
//   when that was computed; recomputed whenever the story's size differs.
// topic_pending: a disagreeing classification waiting for a second vote before it may replace topic.
// text_topics: topic votes keyed by embed_key, not story id, so they survive `cluster --rebuild` and merges; a rebuilt
//   story inherits its section from its members' votes without calling the model.
// story_summaries: the LLM summary shown for a story. summary_state: demand and retry bookkeeping for the writer.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table stories add column if not exists indep int`;
  yield* sql`alter table stories add column if not exists indep_texts int`;
  yield* sql`alter table stories add column if not exists topic_pending text`;

  yield* sql`
    create table if not exists text_topics (
      embed_key text primary key,
      topic     text not null,
      voted_at  timestamptz not null default now()
    )`;

  yield* sql`
    create table if not exists story_summaries (
      story_id     bigint primary key references stories(id) on delete cascade,
      body         text not null,
      input_hash   text not null,
      model        text not null,
      version      int not null,
      indep        int not null,
      generated_at timestamptz not null default now()
    )`;

  yield* sql`
    create table if not exists summary_state (
      story_id        bigint primary key references stories(id) on delete cascade,
      requested_at    timestamptz,
      failures        int not null default 0,
      next_attempt_at timestamptz not null default now()
    )`;
  yield* sql`create index if not exists summary_state_requested on summary_state (requested_at) where requested_at is not null`;
});
