import { Config, Context, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ClassifyError } from "../errors";
import { TOPICS, TOPIC_IDS, isTopic, type TopicId } from "./taxonomy";

export interface ClassifierConfig {
  readonly baseUrl: string; // Ollama native API, e.g. http://localhost:11434
  readonly model: string;
}

const Reply = Schema.Struct({ message: Schema.Struct({ content: Schema.String }) });
const Answer = Schema.Struct({ topic: Schema.String });

const SYSTEM = [
  "You file news stories into exactly one section.",
  ...TOPICS.map((t) => `- ${t.id}: ${t.hint}`),
  "Pick by the main subject, not the setting: a court ruling on a tax law is politics; a company's AI product is tech; a foreign war is world.",
].join("\n");

/** Headline plus a few distinct member titles from other outlets: more signal than the headline alone, still tiny. */
export const promptFor = (headline: string, titles: ReadonlyArray<string>) =>
  `Headline: ${headline}\n` + (titles.length ? `Other coverage:\n${titles.map((t) => `- ${t}`).join("\n")}\n` : "") + "\nWhich section?";

export class Classifier extends Context.Service<Classifier, {
  readonly model: string;
  classify(headline: string, titles: ReadonlyArray<string>): Effect.Effect<TopicId, ClassifyError>;
}>()("news/topics/Classifier") {
  static readonly make = (cfg: ClassifierConfig) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ times: 2, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered) }),
      );
      const classify = Effect.fn("Classifier.classify")(function* (headline: string, titles: ReadonlyArray<string>) {
        const body = {
          model: cfg.model,
          stream: false,
          think: false,
          // The schema's enum constrains decoding, so the answer is always one of our labels.
          format: { type: "object", properties: { topic: { type: "string", enum: TOPIC_IDS } }, required: ["topic"] },
          options: { temperature: 0 },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: promptFor(headline, titles) }],
        };
        const content = yield* HttpClientRequest.post(`${cfg.baseUrl}/api/chat`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Reply)),
          Effect.map((r) => r.message.content),
          Effect.timeout("1 minute"),
          Effect.mapError((cause) => new ClassifyError({ message: `classify request to ${cfg.baseUrl} failed`, cause })),
        );
        const parsed = yield* Effect.try({ try: () => JSON.parse(content), catch: (cause) => new ClassifyError({ message: `unparseable answer: ${content.slice(0, 80)}`, cause }) });
        const topic = yield* Schema.decodeUnknownEffect(Answer)(parsed).pipe(Effect.mapError((cause) => new ClassifyError({ message: "answer has no topic", cause })));
        return isTopic(topic.topic) ? topic.topic : yield* new ClassifyError({ message: `model answered off-taxonomy: ${topic.topic}` });
      });
      return Classifier.of({ model: cfg.model, classify });
    });

  /** Reads TOPIC_BASE_URL / TOPIC_MODEL. */
  static readonly layer = Layer.effect(
    Classifier,
    Effect.gen(function* () {
      const cfg = yield* Config.all({
        baseUrl: Config.String("TOPIC_BASE_URL").pipe(Config.withDefault("http://localhost:11434")),
        model: Config.String("TOPIC_MODEL").pipe(Config.withDefault("gemma4:e2b-mlx")),
      });
      return yield* Classifier.make(cfg);
    }),
  );
}
