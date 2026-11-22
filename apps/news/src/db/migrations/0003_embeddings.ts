import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// One embedding per distinct text (`embed_key`), so syndicated copies share a vector.
//  vec  = raw model output (source of truth)
//  cvec = l2_normalize(vec - mean): the mean-centred copy that is indexed and clustered on. Raw cosines from
//         these models are bunched in a narrow high band, so unrelated articles look similar until centred.
// `embedding_state` pins which model/dimension/prefix produced the vectors and the frozen, versioned mean.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    alter table articles add column if not exists embed_key text
      generated always as (md5(coalesce(title, '') || '. ' || coalesce(lede, ''))) stored`;
  yield* sql`create index if not exists articles_embed_key on articles (embed_key) where reject_reason is null`;

  yield* sql`
    create table if not exists embedding_state (
      id           int primary key default 1 check (id = 1),
      variant      text not null,
      mean         vector(768),
      mean_version int not null default 0,
      mean_n       int,
      updated_at   timestamptz not null default now()
    )`;

  yield* sql`
    create table if not exists embeddings (
      embed_key  text primary key,
      vec        vector(768) not null,
      cvec       vector(768),
      created_at timestamptz not null default now()
    )`;
  yield* sql`create index if not exists embeddings_cvec_hnsw on embeddings using hnsw (cvec vector_cosine_ops)`;
});
