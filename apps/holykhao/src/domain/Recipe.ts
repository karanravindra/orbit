import { Schema } from "effect";

export const TagKind = Schema.Literals(["course", "cuisine", "diet", "occasion"]);
export type TagKind = typeof TagKind.Type;

// Everything is required-but-nullable, so the JSON Schema is valid for Claude's strict structured outputs.
const Str = Schema.NullOr(Schema.String);

export const ParsedIngredient = Schema.Struct({
  quantity: Str,
  unit: Str,
  /** The ingredient as written ("Byadgi chilies"), without quantity or preparation. */
  item: Schema.String,
  note: Str,
  /** Canonical ingredient name: a catalog name when it is the same ingredient, otherwise a short new name. Resolved to a row in code. */
  ingredient: Schema.String,
});
export type ParsedIngredient = typeof ParsedIngredient.Type;

export const ParsedSection = Schema.Struct({
  title: Str,
  ingredients: Schema.Array(ParsedIngredient),
});

export const ParsedTag = Schema.Struct({ kind: TagKind, name: Schema.String });

/** The structured part of a recipe: what the model fills in when it is given typed text. */
export const RecipeBody = Schema.Struct({
  title: Schema.String,
  summary: Str,
  attribution: Str,
  servings: Str,
  prepMinutes: Schema.NullOr(Schema.Int),
  cookMinutes: Schema.NullOr(Schema.Int),
  notes: Str,
  sections: Schema.Array(ParsedSection),
  steps: Schema.Array(Schema.String),
  tags: Schema.Array(ParsedTag),
  warnings: Schema.Array(Schema.String),
});

/** A recipe as stored. For a photo, `rawText` is the model's transcription (written first, then structured). */
export const ParsedRecipe = Schema.Struct({
  rawText: Schema.String,
  ...RecipeBody.fields,
});
export type ParsedRecipe = typeof ParsedRecipe.Type;

/** What one call on a notebook page returns: 1..n recipes. */
export const PageResult = Schema.Struct({ recipes: Schema.Array(ParsedRecipe) });
export type PageResult = typeof PageResult.Type;

/** Frozen view of the catalog that goes into the system prompt. */
export interface CatalogSnapshot {
  readonly ingredients: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly aliases: ReadonlyArray<string> }>;
  readonly tags: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly kind: TagKind }>;
}

export const slugify = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recipe";
