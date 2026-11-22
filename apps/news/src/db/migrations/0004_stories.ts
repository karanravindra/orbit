import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Online clustering state. The unit is a distinct text (`embed_key`), so a wire story syndicated 40 times is one
// member. Articles reach a story through `articles.embed_key`.
//  stories.centroid  = L2-normalised mean of the members' centred vectors (exact scans: the table is small and
//                      every join rewrites a centroid, which would churn an HNSW index).
//  stories.mean_version records which frozen corpus mean the centroid lives in; a new mean needs a rebuild.
//  cluster_seen      = texts already considered (assigned, or judged noise for now).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    create table if not exists stories (
      id           bigserial primary key,
      centroid     vector(768) not null,
      n            int not null,
      first_seen   timestamptz not null,
      last_seen    timestamptz not null,
      mean_version int not null,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    )`;
  yield* sql`create index if not exists stories_last_seen on stories (last_seen)`;

  yield* sql`
    create table if not exists story_texts (
      embed_key   text primary key references embeddings(embed_key) on delete cascade,
      story_id    bigint not null references stories(id) on delete cascade,
      sim         real not null,
      assigned_at timestamptz not null default now()
    )`;
  yield* sql`create index if not exists story_texts_story on story_texts (story_id)`;

  yield* sql`create table if not exists cluster_seen (embed_key text primary key references embeddings(embed_key) on delete cascade)`;
});
