import { Config, Context, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { SummarizeError } from "../errors";
import { checkSummary, messagesFor, type SourceText } from "./prompt";

export interface SummarizerConfig {
  readonly baseUrl: string; // Ollama native API
  readonly model: string;
  /** How long Ollama keeps the model resident after a call, so the next summary needs no model load. */
  readonly keepAlive: string;
}

const Reply = Schema.Struct({ message: Schema.Struct({ content: Schema.String }) });

export class Summarizer extends Context.Service<Summarizer, {
  readonly model: string;
  /** Load the model into memory (a one-token generation). Called once when the writer starts, so the first real summary is not a cold start. */
  warm: Effect.Effect<void>;
  /** Write and check one summary. Fails when the output violates a check (invented number, wrong length, preface). */
  summarize(sources: ReadonlyArray<SourceText>): Effect.Effect<string, SummarizeError>;
}>()("news/summaries/Summarizer") {
  static readonly make = (cfg: SummarizerConfig) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ times: 1, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered) }),
      );
      const chat = (messages: unknown, options: Record<string, unknown>) =>
        HttpClientRequest.post(`${cfg.baseUrl}/api/chat`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ model: cfg.model, stream: false, think: false, keep_alive: cfg.keepAlive, options, messages }),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Reply)),
          Effect.map((r) => r.message.content.trim()),
        );

      const warm = chat([{ role: "user", content: "ok" }], { num_predict: 1 }).pipe(Effect.timeout("2 minutes"), Effect.ignore);

      const summarize = Effect.fn("Summarizer.summarize")(function* (sources: ReadonlyArray<SourceText>) {
        const text = yield* chat(messagesFor(sources), { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 200 }).pipe(
          Effect.timeout("2 minutes"),
          Effect.mapError((cause) => new SummarizeError({ message: `summary request to ${cfg.baseUrl} failed`, cause })),
        );
        const problem = checkSummary(text, sources);
        return problem ? yield* new SummarizeError({ message: `rejected summary: ${problem}` }) : text;
      });
      return Summarizer.of({ model: cfg.model, warm, summarize });
    });

  /** Reads SUMMARY_BASE_URL / SUMMARY_MODEL / SUMMARY_KEEP_ALIVE. */
  static readonly layer = Layer.effect(
    Summarizer,
    Effect.gen(function* () {
      const cfg = yield* Config.all({
        baseUrl: Config.String("SUMMARY_BASE_URL").pipe(Config.withDefault("http://localhost:11434")),
        model: Config.String("SUMMARY_MODEL").pipe(Config.withDefault("gemma4:e2b-mlx")),
        keepAlive: Config.String("SUMMARY_KEEP_ALIVE").pipe(Config.withDefault("30m")),
      });
      return yield* Summarizer.make(cfg);
    }),
  );
}
