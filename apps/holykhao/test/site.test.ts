import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Site, ftsQuery } from "../src/repos/Site";
import { Ingredients } from "../src/repos/Ingredients";
import { Recipes } from "../src/repos/Recipes";
import { recipe, TestLayer } from "./helpers";

describe("ftsQuery", () => {
  test("turns words into prefix terms and strips FTS syntax", () => {
    expect(ftsQuery("toor dal")).toBe('"toor"* "dal"*');
    expect(ftsQuery('" OR * NEAR(')).toBe('"OR"* "NEAR"*');
    expect(ftsQuery("   ")).toBeUndefined();
    expect(ftsQuery("***")).toBeUndefined();
  });
});

const withSite = (drafts: boolean) => Site.make(drafts).pipe(Layer.provideMerge(TestLayer));
const runSite = <A>(drafts: boolean, eff: Effect.Effect<A, never, Site | Recipes | Ingredients>) => Effect.runPromise(eff.pipe(Effect.provide(withSite(drafts))));

describe("Site", () => {
  const seed = Effect.gen(function* () {
    const recipes = yield* Recipes;
    yield* (yield* Ingredients).ensure("Toor dal", ["tur dal", "pigeon peas"], true);
    const a = yield* recipes.saveParsed(recipe({ title: "Hotel-Style Sambar" }), { sourceRef: "a#1", model: "stub" });
    yield* recipes.saveParsed(recipe({ title: "Secret Draft" }), { sourceRef: "b#1", model: "stub" });
    yield* recipes.publish([a.slug], false);
  });

  test("search ranks by title and finds ingredients by alias; drafts hidden", () =>
    runSite(
      false,
      Effect.gen(function* () {
        yield* seed;
        const site = yield* Site;
        expect((yield* site.search("sam")).map((c) => c.title)).toEqual(["Hotel-Style Sambar"]);
        expect((yield* site.search("pigeon peas")).map((c) => c.title)).toEqual(["Hotel-Style Sambar"]);
        expect(yield* site.search("secret")).toEqual([]);
        expect(yield* site.search('"; drop table recipes; --')).toEqual([]); // safe, no throw
        expect((yield* site.home).recent.map((c) => c.title)).toEqual(["Hotel-Style Sambar"]);
        expect((yield* site.byTag("south-indian"))?.recipes.length).toBe(1);
        expect((yield* site.byIngredient("toor-dal"))?.recipes.length).toBe(1);
        expect(yield* site.recipe("secret-draft")).toBeUndefined();
      }),
    ));

  test("--drafts shows drafts", () =>
    runSite(
      true,
      Effect.gen(function* () {
        yield* seed;
        const site = yield* Site;
        expect((yield* site.search("secret")).map((c) => c.title)).toEqual(["Secret Draft"]);
        expect((yield* site.recipe("secret-draft"))?.status).toBe("draft");
      }),
    ));
});
