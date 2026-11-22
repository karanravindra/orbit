import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Ingredients } from "../src/repos/Ingredients";
import { Recipes } from "../src/repos/Recipes";
import { ing, recipe, run } from "./helpers";

describe("saveParsed", () => {
  test("creates a draft with structure, ingredient, tag and FTS row", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        yield* (yield* Ingredients).ensure("Toor dal", ["tur dal", "pigeon peas"], true); // what the seed pass does
        const saved = yield* recipes.saveParsed(recipe(), { sourceRef: "recipe_1#1", model: "stub" });
        expect(saved.created).toBe(true);
        expect(saved.slug).toBe("test-recipe");
        const r = (yield* recipes.bySlug("test-recipe", true))!;
        expect(r.status).toBe("draft");
        expect(r.sections[0]!.ingredients[0]).toMatchObject({ quantity: "1/4", unit: "cup", item: "toor dal", ingredientSlug: "toor-dal" });
        expect(r.steps).toEqual(["Pressure-cook the dal."]);
        expect(r.tags.map((t) => t.slug)).toEqual(["south-indian"]);
        const sql = yield* SqlClient.SqlClient;
        // Found by an alias of the canonical ingredient, not just by the words written in the recipe.
        const hits = yield* sql`select rowid from recipes_fts where recipes_fts match '"pigeon"*'`;
        expect(hits.length).toBe(1);
        expect(yield* recipes.bySlug("test-recipe", false)).toBeUndefined(); // drafts are hidden from the public view
      }),
    ));

  test("re-saving the same source_ref updates in place (idempotent import)", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        const a = yield* recipes.saveParsed(recipe(), { sourceRef: "recipe_1#1", model: "stub" });
        yield* recipes.publish([a.slug], false);
        const b = yield* recipes.saveParsed(recipe({ title: "Renamed", steps: ["one", "two"] }), { sourceRef: "recipe_1#1", model: "stub" });
        expect(b).toMatchObject({ id: a.id, slug: a.slug, created: false });
        const r = (yield* recipes.bySlug(a.slug, true))!;
        expect(r.title).toBe("Renamed");
        expect(r.steps.length).toBe(2);
        expect(r.status).toBe("published"); // re-parse keeps the publish state
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`select 1 from recipes_fts`).length).toBe(1);
        expect((yield* sql`select 1 from recipe_ingredients`).length).toBe(1);
      }),
    ));

  test("a page with several recipes gets #1..#n refs and unique slugs", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        const a = yield* recipes.saveParsed(recipe({ title: "Oven Fries" }), { sourceRef: "recipe_314#1", model: "stub" });
        const b = yield* recipes.saveParsed(recipe({ title: "Oven Fries" }), { sourceRef: "recipe_314#2", model: "stub" });
        expect(a.slug).toBe("oven-fries");
        expect(b.slug).toBe("oven-fries-2");
        expect(yield* recipes.sourceRefs).toEqual(new Set(["recipe_314#1", "recipe_314#2"]));
      }),
    ));

  test("an unknown canonical name falls back to the written item, then creates an unreviewed ingredient", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        const ingredients = yield* Ingredients;
        yield* ingredients.ensure("Toor dal", ["tur dal"], true);
        const second = recipe({
          title: "Second",
          sections: [{ title: "Masala", ingredients: [ing("tur dal", { ingredient: "Mystery legume" }), ing("gagase", { ingredient: "Poppy seeds" })] }],
        });
        const saved = yield* recipes.saveParsed(second, { sourceRef: "b#1", model: "stub" });
        const r = (yield* recipes.bySlug(saved.slug, true))!;
        expect(r.sections[0]!.title).toBe("Masala");
        expect(r.sections[0]!.ingredients.map((l) => l.ingredientSlug)).toEqual(["toor-dal", "poppy-seeds"]); // item alias hit, then created
        expect((yield* ingredients.list(true)).map((i) => i.slug)).toEqual(["poppy-seeds"]); // only the new one needs review
        expect((yield* ingredients.catalog).ingredients.find((i) => i.slug === "poppy-seeds")!.aliases).toContain("gagase");
      }),
    ));

  test("a line noted 'optional' is stored as optional", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        const saved = yield* recipes.saveParsed(recipe({ sections: [{ title: null, ingredients: [ing("cashews", { note: "Optional, roasted" }), ing("salt")] }] }), { sourceRef: "o#1", model: "stub" });
        const rows = (yield* recipes.bySlug(saved.slug, true))!.sections[0]!.ingredients;
        expect(rows.map((l) => l.optional)).toEqual([true, false]);
      }),
    ));

  test("merge moves lines and aliases", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        const ingredients = yield* Ingredients;
        yield* recipes.saveParsed(recipe(), { sourceRef: "a#1", model: "stub" });
        yield* recipes.saveParsed(recipe({ title: "Other", sections: [{ title: null, ingredients: [ing("pigeon peas dal", { ingredient: "Pigeon pea dal" })] }] }), { sourceRef: "b#1", model: "stub" });
        expect(yield* ingredients.merge("pigeon-pea-dal", "toor-dal")).toBe(true);
        const r = (yield* recipes.bySlug("other", true))!;
        expect(r.sections[0]!.ingredients[0]!.ingredientSlug).toBe("toor-dal");
        expect((yield* ingredients.list(false)).map((i) => i.slug)).toEqual(["toor-dal"]);
      }),
    ));

  test("publish --all-clean skips drafts with warnings", () =>
    run(
      Effect.gen(function* () {
        const recipes = yield* Recipes;
        yield* recipes.saveParsed(recipe({ title: "Clean" }), { sourceRef: "a#1", model: "stub" });
        yield* recipes.saveParsed(recipe({ title: "Warned", warnings: ["illegible"] }), { sourceRef: "b#1", model: "stub" });
        expect(yield* recipes.publish([], true)).toBe(1);
        expect((yield* recipes.list({ status: "published" })).map((r) => r.slug)).toEqual(["clean"]);
      }),
    ));
});
