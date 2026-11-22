import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ingredientLines, listPages } from "../src/import/corpus";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "holykhao-corpus-"));
  await Bun.write(join(dir, "recipe_10.png"), "x");
  await Bun.write(join(dir, "recipe_10.md"), "# A\n\n## Ingredients\n\n- 1 cup rice\n- Salt\n\n## Method\n\n1. Cook.\n");
  await Bun.write(join(dir, "recipe_2.png"), "x"); // no .md hint
  await Bun.write(join(dir, "recipe_3.md"), "- 1 cup RICE\n- 2 eggs\n"); // md without a photo: still feeds the seed pass
  await Bun.write(join(dir, "notes.png"), "x"); // ignored
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("listPages pairs photos with hints, in numeric order", async () => {
  const pages = await Effect.runPromise(listPages(dir));
  expect(pages.map((p) => p.id)).toEqual(["recipe_2", "recipe_10"]);
  expect(pages[0]!.hint).toBeNull();
  expect(pages[1]!.hint).toContain("1 cup rice");
});

test("ingredientLines collects distinct bullets across all hints", async () => {
  const lines = await Effect.runPromise(ingredientLines(dir));
  expect(lines).toEqual(["1 cup rice", "2 eggs", "Salt"]);
});
