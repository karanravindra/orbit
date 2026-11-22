import { Config, Context, Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { PageResult, RecipeBody, type CatalogSnapshot, type ParsedRecipe } from "../domain/Recipe";
import { ParseError } from "../errors";
import { PAGE_TASK, seedPrompt, SeedResult, systemPrompt, TEXT_TASK } from "./prompt";

export interface PageImage {
  readonly base64: string;
  readonly mediaType: "image/jpeg" | "image/png";
}

export interface ParserConfig {
  /** OpenAI-compatible base URL, e.g. Ollama's http://localhost:11434/v1 */
  readonly baseUrl: string;
  /** Must be vision-capable for `import`. */
  readonly model: string;
  /** Sent as a bearer token when set. Ollama ignores it; other servers may need it. */
  readonly apiKey: string;
  /** Re-ask this many times when the model returns unusable JSON. */
  readonly attempts: number;
}

/** Structured outputs want `additionalProperties: false` and no numeric bounds. */
const strictify = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(strictify);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "minimum" || k === "maximum") continue;
      out[k] = strictify(v);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  }
  return node;
};

const jsonSchemaOf = (schema: Schema.Top) => strictify(Schema.toJsonSchemaDocument(schema).schema) as { [key: string]: unknown };

export const bodyJsonSchema = jsonSchemaOf(RecipeBody);
export const pageJsonSchema = jsonSchemaOf(PageResult);
const seedJsonSchema = jsonSchemaOf(SeedResult);

const ChatResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

type Part = { readonly type: "text"; readonly text: string } | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

/** Turns free text or a notebook photo into structured recipes with one chat-completions call to any OpenAI-compatible server (Ollama by default). */
export class Parser extends Context.Service<Parser, {
  readonly model: string;
  parseText(rawText: string, catalog: CatalogSnapshot): Effect.Effect<ParsedRecipe, ParseError>;
  /** One photographed page -> 1..n recipes. `hint` is a rough typed transcription, if there is one. */
  parsePage(image: PageImage, hint: string | null, catalog: CatalogSnapshot): Effect.Effect<ReadonlyArray<ParsedRecipe>, ParseError>;
  /** Group raw ingredient lines into canonical ingredients (name + aliases), reusing names already in the catalog. */
  canonicalize(lines: ReadonlyArray<string>, catalog: CatalogSnapshot): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly aliases: ReadonlyArray<string> }>, ParseError>;
}>()("holykhao/parse/Parser") {
  static readonly make = (cfg: ParserConfig) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ times: 2, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered) }),
      );

      /** One generation: system + user content in, schema-decoded value out. */
      const once = Effect.fn("Parser.once")(function* <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S,
        jsonSchema: { [key: string]: unknown },
        system: string,
        user: string | ReadonlyArray<Part>,
      ) {
        const body = {
          model: cfg.model,
          temperature: 0,
          stream: false,
          max_tokens: 8192,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: jsonSchema } },
        };
        const res = yield* HttpClientRequest.post(`${cfg.baseUrl}/chat/completions`).pipe(
          cfg.apiKey ? HttpClientRequest.bearerToken(cfg.apiKey) : (r) => r,
          HttpClientRequest.bodyJsonUnsafe(body),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatResponse)),
          Effect.timeout("10 minutes"),
          Effect.mapError((cause) => new ParseError({ message: `chat request to ${cfg.baseUrl} (model ${cfg.model}) failed; is the server running and the model pulled?`, cause })),
        );
        const choice = res.choices[0];
        if (!choice) return yield* new ParseError({ message: "the model returned no choices" });
        if (choice.finish_reason === "length") {
          return yield* new ParseError({ message: "the model's answer was cut off (max_tokens or context length)", retryable: true });
        }
        const text = choice.message.content ?? "";
        const json = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) => new ParseError({ message: `the model returned invalid JSON: ${text.slice(0, 120)}`, cause, retryable: true }),
        });
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError((cause) => new ParseError({ message: `the model's JSON didn't match the schema: ${cause.message}`, cause, retryable: true })),
        );
      });

      // A small local model sometimes fumbles the JSON; ask again a couple of times, but never for connection problems.
      const call = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, jsonSchema: { [key: string]: unknown }, system: string, user: string | ReadonlyArray<Part>) =>
        once(schema, jsonSchema, system, user).pipe(Effect.retry({ times: cfg.attempts - 1, while: (e) => e.retryable === true }));

      const parseText = Effect.fn("Parser.parseText")(function* (rawText: string, catalog: CatalogSnapshot) {
        const body = yield* call(RecipeBody, bodyJsonSchema, systemPrompt(catalog), `${TEXT_TASK}\n\n<recipe>\n${rawText}\n</recipe>`);
        // The text is already in hand, so the model isn't asked to repeat it.
        return { rawText: rawText.trim(), ...body };
      });

      const parsePage = Effect.fn("Parser.parsePage")(function* (image: PageImage, hint: string | null, catalog: CatalogSnapshot) {
        const parts: ReadonlyArray<Part> = [
          { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
          { type: "text", text: hint ? `${PAGE_TASK}\n\n<hint>\n${hint}\n</hint>` : `${PAGE_TASK}\n\n(No typed hint is available for this page.)` },
        ];
        const result = yield* call(PageResult, pageJsonSchema, systemPrompt(catalog), parts);
        if (result.recipes.length === 0) return yield* new ParseError({ message: "the model found no recipe on the page" });
        return result.recipes;
      });

      const canonicalize = Effect.fn("Parser.canonicalize")(function* (lines: ReadonlyArray<string>, catalog: CatalogSnapshot) {
        const result = yield* call(SeedResult, seedJsonSchema, seedPrompt(catalog), `Group these ingredient lines into canonical ingredients.\n\n<lines>\n${lines.join("\n")}\n</lines>`);
        return result.ingredients;
      });

      return Parser.of({ model: cfg.model, parseText, parsePage, canonicalize });
    });

  /** Reads HOLYKHAO_LLM_URL / HOLYKHAO_MODEL / HOLYKHAO_LLM_API_KEY / HOLYKHAO_LLM_ATTEMPTS. Needs an `HttpClient`. */
  static readonly layer = Layer.effect(
    Parser,
    Effect.gen(function* () {
      const cfg = yield* Config.all({
        baseUrl: Config.String("HOLYKHAO_LLM_URL").pipe(Config.withDefault("http://localhost:11434/v1")),
        model: Config.String("HOLYKHAO_MODEL").pipe(Config.withDefault("lfm2.5-vl:3b")),
        apiKey: Config.String("HOLYKHAO_LLM_API_KEY").pipe(Config.withDefault("")),
        attempts: Config.Int("HOLYKHAO_LLM_ATTEMPTS").pipe(Config.withDefault(3)),
      });
      return yield* Parser.make(cfg);
    }),
  );
}
