import { Context, Effect, Layer } from "effect";
import type { EmbedError, VariantMismatch } from "../errors";
import { Embedder } from "../embed/Embedder";
import { Embeddings } from "../repos/Embeddings";

const PAGE = 512; // texts read from Postgres per round
const BATCH = 32; // texts per Ollama request
const MIN_MEAN_N = 1000; // vectors needed before the corpus mean is frozen

export class Embed extends Context.Service<Embed, {
  /** Embed every pending text (up to `limit`). Returns how many were embedded. */
  run(limit?: number): Effect.Effect<number, EmbedError | VariantMismatch>;
}>()("news/pipeline/Embed") {
  static readonly layer = Layer.effect(
    Embed,
    Effect.gen(function* () {
      const embedder = yield* Embedder;
      const embeddings = yield* Embeddings;

      const run = Effect.fn("Embed.run")(function* (limit: number = Infinity) {
        yield* embeddings.ensureVariant(embedder.variant);
        let done = 0;
        const t0 = performance.now();
        while (done < limit) {
          const page = yield* embeddings.pending(Math.min(PAGE, limit - done));
          if (page.length === 0) break;
          const batches = Array.from({ length: Math.ceil(page.length / BATCH) }, (_, i) => page.slice(i * BATCH, (i + 1) * BATCH));
          const vectors = yield* Effect.forEach(
            batches,
            (b) => embedder.embed(b.map((t) => `${t.title}. ${t.lede}`)).pipe(Effect.map((vs) => b.map((t, i) => ({ embedKey: t.embedKey, vec: vs[i]! })))),
            { concurrency: 2 },
          );
          yield* embeddings.save(vectors.flat());
          done += page.length;
          const rate = (done / ((performance.now() - t0) / 1000)).toFixed(1);
          yield* Effect.log(`embedded ${done} texts @ ${rate}/s`);
        }
        if (yield* embeddings.freezeMeanIfReady(MIN_MEAN_N)) yield* Effect.log("froze corpus mean (v1) and centred all vectors");
        return done;
      });

      return Embed.of({ run });
    }),
  );
}
