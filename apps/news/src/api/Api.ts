import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

export const BiasCounts = Schema.Struct({
  left: Schema.Number,
  leanLeft: Schema.Number,
  center: Schema.Number,
  leanRight: Schema.Number,
  right: Schema.Number,
  unrated: Schema.Number,
});

const StoryFields = {
  id: Schema.Number,
  headline: Schema.String,
  image: Schema.NullOr(Schema.String),
  /** Distinct owner groups covering the story (the unit of coverage). */
  outlets: Schema.Number,
  articles: Schema.Number,
  /** Distinct texts: syndicated copies count once. */
  texts: Schema.Number,
  firstSeen: Schema.DateFromString,
  lastSeen: Schema.DateFromString,
  bias: BiasCounts,
  /** The side of the spectrum that mostly ignores this story, if any. */
  blindspot: Schema.NullOr(Schema.Literals(["left", "right"])),
  /** Section id, null until classified. */
  topic: Schema.NullOr(Schema.String),
};

export const StorySummary = Schema.Struct(StoryFields);

export const Source = Schema.Struct({
  url: Schema.String,
  image: Schema.NullOr(Schema.String),
  title: Schema.String,
  lede: Schema.NullOr(Schema.String),
  domain: Schema.String,
  outlet: Schema.String,
  bias: Schema.NullOr(Schema.String),
  factuality: Schema.NullOr(Schema.String),
  family: Schema.NullOr(Schema.String),
  inherited: Schema.Boolean,
  contested: Schema.Boolean,
  seenAt: Schema.DateFromString,
});

export const StoryDetail = Schema.Struct({ ...StoryFields, sources: Schema.Array(Source) });

export class StoriesGroup extends HttpApiGroup.make("stories").add(
  HttpApiEndpoint.get("list", "/stories", {
    query: {
      limit: Schema.optional(Schema.FiniteFromString),
      minOutlets: Schema.optional(Schema.FiniteFromString),
      /** Only stories updated within this many hours (default 48). */
      hours: Schema.optional(Schema.FiniteFromString),
      sort: Schema.optional(Schema.Literals(["coverage", "recent"])),
      blindspot: Schema.optional(Schema.Literals(["true", "false"])),
      /** Section id, e.g. politics (see GET /topics). */
      topic: Schema.optional(Schema.String),
    },
    success: Schema.Array(StorySummary),
  }),
  HttpApiEndpoint.get("topics", "/topics", {
    query: { minOutlets: Schema.optional(Schema.FiniteFromString), hours: Schema.optional(Schema.FiniteFromString) },
    success: Schema.Array(Schema.Struct({ topic: Schema.NullOr(Schema.String), label: Schema.String, stories: Schema.Number })),
  }),
  HttpApiEndpoint.get("get", "/stories/:id", {
    params: { id: Schema.FiniteFromString },
    success: StoryDetail,
    error: HttpApiError.NotFoundNoContent,
  }),
) {}

export class SystemGroup extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
) {}

export class Api extends HttpApi.make("news").add(StoriesGroup).add(SystemGroup).annotateMerge(OpenApi.annotations({ title: "News stories API" })) {}
