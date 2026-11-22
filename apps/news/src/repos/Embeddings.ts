import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { VariantMismatch } from "../errors";

export interface PendingText {
  readonly embedKey: string;
  readonly title: string;
  readonly lede: string;
}

export interface EmbeddingStats {
  readonly variant: string | null;
  readonly embedded: number;
  readonly unembedded: number;
  readonly centered: number;
  readonly meanVersion: number;
}

const pgVector = (v: Float32Array): string => `[${Array.from(v).join(",")}]`;

/** `embeddings` (one row per distinct text) + `embedding_state` (variant and frozen mean). DB failures are defects. */
export class Embeddings extends Context.Service<Embeddings, {
  /** Pin the embedding variant. Fails if vectors from a different one are stored. */
  ensureVariant(variant: string): Effect.Effect<void, VariantMismatch>;
  /** Distinct, not-yet-embedded article texts. */
  pending(limit: number): Effect.Effect<ReadonlyArray<PendingText>>;
  /** Store vectors; the centred copy is filled in when a mean exists. */
  save(rows: ReadonlyArray<{ readonly embedKey: string; readonly vec: Float32Array }>): Effect.Effect<void>;
  /** First mean: once `minN` vectors exist and no mean is set, freeze avg(vec) and centre everything. Returns true if it ran. */
  freezeMeanIfReady(minN: number): Effect.Effect<boolean>;
  /** Drop all vectors and the state (needed after changing model/dimension/prefix). */
  reset: Effect.Effect<void>;
  stats: Effect.Effect<EmbeddingStats>;
}>()("news/repos/Embeddings") {
  static readonly layer = Layer.effect(
    Embeddings,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const ensureVariant = Effect.fn("Embeddings.ensureVariant")(function* (variant: string) {
        const rows = yield* sql<{ variant: string }>`select variant from embedding_state where id = 1`.pipe(Effect.orDie);
        const stored = rows[0]?.variant;
        if (stored === undefined) {
          yield* sql`insert into embedding_state (id, variant) values (1, ${variant}) on conflict (id) do nothing`.pipe(Effect.orDie);
        } else if (stored !== variant) {
          return yield* new VariantMismatch({ stored, configured: variant });
        }
      });

      const pending = Effect.fn("Embeddings.pending")(function* (limit: number) {
        const rows = yield* sql<PendingText>`
          select distinct on (a.embed_key) a.embed_key, a.title, a.lede
          from articles a
          where a.reject_reason is null and a.title is not null and a.lede is not null
            and not exists (select 1 from embeddings e where e.embed_key = a.embed_key)
          order by a.embed_key
          limit ${limit}`;
        return rows as ReadonlyArray<PendingText>;
      }, Effect.orDie);

      const save = Effect.fn("Embeddings.save")(function* (rows: ReadonlyArray<{ readonly embedKey: string; readonly vec: Float32Array }>) {
        if (rows.length === 0) return;
        const json = JSON.stringify(rows.map((r) => ({ k: r.embedKey, v: pgVector(r.vec) })));
        yield* sql`
          insert into embeddings (embed_key, vec, cvec)
          select r.k, r.v::vector, case when s.mean is null then null else l2_normalize(r.v::vector - s.mean) end
          from json_to_recordset(${json}::json) as r(k text, v text)
          cross join embedding_state s
          on conflict (embed_key) do nothing`;
      }, Effect.orDie);

      const freezeMeanIfReady = Effect.fn("Embeddings.freezeMeanIfReady")(function* (minN: number) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [s] = yield* sql<{ hasMean: boolean; n: number }>`
              select (select mean is not null from embedding_state where id = 1) as has_mean, (select count(*)::int from embeddings) as n`;
            if (!s || s.hasMean || s.n < minN) return false;
            yield* sql`update embedding_state set mean = (select avg(vec) from embeddings), mean_n = ${s.n}, mean_version = mean_version + 1, updated_at = now() where id = 1`;
            yield* sql`update embeddings set cvec = l2_normalize(vec - (select mean from embedding_state where id = 1))`;
            return true;
          }),
        );
      }, Effect.orDie);

      const reset = Effect.gen(function* () {
        yield* sql`truncate embeddings`;
        yield* sql`delete from embedding_state`;
      }).pipe(Effect.orDie, Effect.withSpan("Embeddings.reset"));

      const stats = Effect.gen(function* () {
        const [r] = yield* sql<{ variant: string | null; embedded: number; centered: number; meanVersion: number | null }>`
          select (select variant from embedding_state where id = 1) as variant,
                 (select count(*)::int from embeddings) as embedded,
                 (select count(*)::int from embeddings where cvec is not null) as centered,
                 (select mean_version from embedding_state where id = 1) as mean_version`;
        const [u] = yield* sql<{ n: number }>`
          select count(distinct a.embed_key)::int as n from articles a
          where a.reject_reason is null and a.title is not null and a.lede is not null
            and not exists (select 1 from embeddings e where e.embed_key = a.embed_key)`;
        return { variant: r!.variant, embedded: r!.embedded, unembedded: u!.n, centered: r!.centered, meanVersion: r!.meanVersion ?? 0 } as EmbeddingStats;
      }).pipe(Effect.orDie, Effect.withSpan("Embeddings.stats"));

      return Embeddings.of({ ensureVariant, pending, save, freezeMeanIfReady, reset, stats });
    }),
  );
}
