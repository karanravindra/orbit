import { SqliteClient } from "@effect/sql-sqlite-bun";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, String as Str } from "effect";
import type { SqlClient } from "effect/sql";
import type { ParsedIngredient, ParsedRecipe } from "../src/domain/Recipe";
import { migrate } from "../src/db/Db";
import { Ingredients } from "../src/repos/Ingredients";
import { Recipes } from "../src/repos/Recipes";

const Sqlite = SqliteClient.layer({ filename: ":memory:", transformResultNames: Str.snakeToCamel, transformQueryNames: Str.camelToSnake });

/** Fresh migrated in-memory DB with the repos on top. */
export const TestLayer = Layer.mergeAll(Recipes.layer.pipe(Layer.provideMerge(Ingredients.layer))).pipe(
  Layer.provideMerge(Layer.effectDiscard(migrate)),
  Layer.provideMerge(Layer.mergeAll(Sqlite, BunServices.layer)),
);

export const ing = (item: string, over: Partial<ParsedIngredient> = {}): ParsedIngredient => ({
  quantity: null, unit: null, item, note: null, ingredient: item, ...over,
});

export const recipe = (over: Partial<ParsedRecipe> = {}): ParsedRecipe => ({
  rawText: "raw", title: "Test Recipe", summary: null, attribution: null, servings: null, prepMinutes: null, cookMinutes: null, notes: null,
  sections: [{ title: null, ingredients: [ing("toor dal", { quantity: "1/4", unit: "cup", ingredient: "Toor dal" })] }],
  steps: ["Pressure-cook the dal."], tags: [{ kind: "cuisine", name: "South Indian" }], warnings: [], ...over,
});

export const run = <A, E>(eff: Effect.Effect<A, E, Recipes | Ingredients | SqlClient.SqlClient>) => Effect.runPromise(eff.pipe(Effect.provide(TestLayer)) as Effect.Effect<A, E>);
