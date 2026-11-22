import { Schema } from "effect";

export class GdeltError extends Schema.TaggedError<GdeltError>()("GdeltError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A page that couldn't be downloaded. `retryable` decides retry-with-backoff vs. give up. */
export class FetchError extends Schema.TaggedError<FetchError>()("FetchError", {
  url: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  /** Server-requested wait (capped `Retry-After`), if any. */
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

/** The domain's circuit is open (recent 429/5xx/timeouts): park the job instead of hammering it. */
export class DomainCooldown extends Schema.TaggedError<DomainCooldown>()("DomainCooldown", {
  url: Schema.String,
  retryAfterMs: Schema.Number,
}) {}

export class ExtractError extends Schema.TaggedError<ExtractError>()("ExtractError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EmbedError extends Schema.TaggedError<EmbedError>()("EmbedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ClassifyError extends Schema.TaggedError<ClassifyError>()("ClassifyError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The DB holds vectors from a different model/dimension/prefix than the one configured. */
export class VariantMismatch extends Schema.TaggedError<VariantMismatch>()("VariantMismatch", {
  stored: Schema.String,
  configured: Schema.String,
}) {}

/** Stories were built on another corpus mean (or none exists yet): rebuild them. */
export class ClusterStale extends Schema.TaggedError<ClusterStale>()("ClusterStale", {
  message: Schema.String,
}) {}

export class SummarizeError extends Schema.TaggedError<SummarizeError>()("SummarizeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
