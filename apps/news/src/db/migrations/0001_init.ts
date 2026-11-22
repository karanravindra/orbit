import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`create extension if not exists vector`;

  // GDELT 15-minute slices already ingested. Slices that 404 are never recorded, so they're retried.
  yield* sql`
    create table if not exists gdelt_slices (
      ts          timestamptz not null,
      kind        text not null,
      n_urls      int not null,
      ingested_at timestamptz not null default now(),
      primary key (ts, kind)
    )`;

  // Every URL GDELT showed us. Doubles as the fetch queue:
  //   pending -> (fetch) -> ok | retry (transient, backoff) | failed (permanent or out of attempts)
  yield* sql`
    create table if not exists urls (
      url             text primary key,
      domain          text not null,
      seen_at         timestamptz not null,
      title_hint      text,
      fetch_status    text not null default 'pending' check (fetch_status in ('pending','retry','ok','failed')),
      last_status     text,
      attempts        int not null default 0,
      next_attempt_at timestamptz not null default now(),
      leased_until    timestamptz,
      updated_at      timestamptz not null default now()
    )`;
  yield* sql`create index if not exists urls_queue on urls (seen_at desc) where fetch_status in ('pending','retry')`;

  // One row per fetched page. reject_reason is null for usable articles.
  yield* sql`
    create table if not exists articles (
      id            bigserial primary key,
      url           text not null unique references urls(url) on delete cascade,
      domain        text not null,
      sitename      text,
      title         text,
      lede          text,
      body          text,
      title_key     text,
      text_hash     text,
      seen_at       timestamptz not null,
      published_at  timestamptz,
      reject_reason text,
      created_at    timestamptz not null default now()
    )`;
  yield* sql`create index if not exists articles_seen on articles (seen_at) where reject_reason is null`;
  yield* sql`create index if not exists articles_hash on articles (text_hash) where reject_reason is null`;
});
