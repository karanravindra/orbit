import { Config, Context, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { EmbedError } from "../errors";

export interface EmbedderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly dim: number;
  /** Task prefix prepended to every input. Empty for embeddinggemma: on labelled pairs it beat the "clustering" prefix. */
  readonly prefix: string;
}

const Response = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Number, embedding: Schema.Array(Schema.Number) })),
});

const l2 = (v: ReadonlyArray<number>): Float32Array => {
  const out = Float32Array.from(v);
  let s = 0;
  for (const x of out) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
};

export class Embedder extends Context.Service<Embedder, {
  /** Identifies what produced a vector: model, dimension and prefix. Stored with the vectors; a change needs a re-embed. */
  readonly variant: string;
  readonly dim: number;
  /** Embed texts (prefix applied here). Output is L2-normalised, in input order. */
  embed(texts: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Float32Array>, EmbedError>;
}>()("news/embed/Embedder") {
  static readonly make = (cfg: EmbedderConfig) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ times: 3, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered) }),
      );
      const fail = (message: string) => (cause: unknown) => new EmbedError({ message, cause });

      const embed = Effect.fn("Embedder.embed")(function* (texts: ReadonlyArray<string>) {
        if (texts.length === 0) return [] as ReadonlyArray<Float32Array>;
        const body = { model: cfg.model, input: texts.map((t) => cfg.prefix + t), dimensions: cfg.dim };
        const res = yield* HttpClientRequest.post(`${cfg.baseUrl}/embeddings`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
          Effect.timeout("2 minutes"),
          Effect.mapError(fail(`embedding request to ${cfg.baseUrl} failed`)),
        );
        if (res.data.length !== texts.length) return yield* new EmbedError({ message: `asked for ${texts.length} embeddings, got ${res.data.length}` });
        const sorted = [...res.data].sort((a, b) => a.index - b.index);
        const bad = sorted.find((d) => d.embedding.length !== cfg.dim);
        if (bad) return yield* new EmbedError({ message: `model ${cfg.model} returned ${bad.embedding.length}-dim vectors, expected ${cfg.dim}` });
        return sorted.map((d) => l2(d.embedding));
      });

      return Embedder.of({ variant: `${cfg.model}|${cfg.dim}|${cfg.prefix}`, dim: cfg.dim, embed });
    });

  /** Reads EMBED_BASE_URL / EMBED_MODEL / EMBED_DIM / EMBED_PREFIX. */
  static readonly layer = Layer.effect(
    Embedder,
    Effect.gen(function* () {
      const cfg = yield* Config.all({
        baseUrl: Config.String("EMBED_BASE_URL").pipe(Config.withDefault("http://localhost:11434/v1")),
        model: Config.String("EMBED_MODEL").pipe(Config.withDefault("embeddinggemma-2:270m")),
        dim: Config.Int("EMBED_DIM").pipe(Config.withDefault(768)),
        prefix: Config.String("EMBED_PREFIX").pipe(Config.withDefault("")),
      });
      return yield* Embedder.make(cfg);
    }),
  );
}
