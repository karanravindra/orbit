import { Schema } from "effect";

/** The LLM call or its output couldn't be turned into a recipe. */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** The model answered badly (invalid JSON, wrong shape): asking again may help. Connection problems are not retryable. */
  retryable: Schema.optional(Schema.Boolean),
}) {}

/** Something on disk (corpus file, image) couldn't be read or converted. */
export class CorpusError extends Schema.TaggedError<CorpusError>()("CorpusError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
