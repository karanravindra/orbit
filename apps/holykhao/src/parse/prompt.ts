import { Schema } from "effect";
import type { CatalogSnapshot } from "../domain/Recipe";

const RULES = `You turn a family recipe into structured JSON for a personal recipe website. The recipes come from a mother's handwritten notebooks (South Indian and other home cooking, plus clippings), so expect shorthand, regional ingredient names, and loose amounts.

Rules:
- Be faithful. Never invent quantities, ingredients, steps, times or servings. If something isn't written, use null.
- Keep the wording of the source; only fix obvious slips when the source clearly shows the intended word (for example "Reason" for "Season"). Do not rewrite or embellish.
- Ingredient lines: split into quantity, unit, item, note.
  - "quantity" is text exactly as written ("15–20", "1 1/4–1 1/2", "fistful", "1/4"); null if none or if the amount is only "to taste".
  - "unit" is a short normalized unit when there is one (tsp, tbsp, cup, g, kg, ml, l, oz, lb, inch, pinch, clove, ...); null otherwise.
  - "item" is only the ingredient, without quantity or preparation ("tomatoes", not "2 tomatoes, chopped").
  - "note" holds preparation and qualifiers ("chopped", "fry 2 / blend 1", "to taste", "for garnish", "optional").
  - Keep the original order. Group lines into sections only when the source has headings ("For the masala", "Tempering"); otherwise use one section with a null title.
- "ingredient" on each line is the canonical ingredient name. If the line is the same ingredient as one in the catalog below (matching its name or any alias, including other spellings and English names), copy that catalog name exactly. Otherwise write a short canonical English name in lower case. Do not merge distinct ingredients (red chilies vs Byadgi chilies are different; toor dal and tur dal are the same).
- Steps: one entry per step, in order, without numbering.
- "notes": tips or remarks that are not steps (for example "Water very important for proper fermentation").
- "attribution": only when the source names where the recipe came from (a brand, TV show, magazine, person). Null for plain family recipes.
- Tags: pick from the existing tags below where they fit; add a new tag only when none fit. Kinds: course (breakfast, main, side, snack, dessert, drink, ...), cuisine (south-indian, north-indian, ...), diet (vegetarian, vegan, ...), occasion (festival, everyday, ...). Keep it to a handful of tags.
- "warnings": one short string for anything the reader of the site should double-check: illegible or cut-off text, a stub with no real instructions, ambiguous amounts, or disagreement between sources.
- A source with only a title and a pointer to somewhere else is still one recipe: keep the title, leave empty lists, and add a warning.
- "servings", "prepMinutes", "cookMinutes" and "summary" are null unless the source states them. "warnings" is an empty array unless there is a real problem.
- Method steps never go in the ingredient sections, and ingredient lines never go in the steps.`;

const fmt = (c: CatalogSnapshot): string => {
  const ing = c.ingredients.length
    ? c.ingredients.map((i) => `${i.name}${i.aliases.length ? ` (aliases: ${i.aliases.join(", ")})` : ""}`).join("\n")
    : "(empty)";
  const tags = c.tags.length ? c.tags.map((t) => `${t.kind}: ${t.name}`).join("\n") : "(none yet)";
  return `\n\nIngredient catalog (canonical name, with aliases):\n${ing}\n\nExisting tags (kind: name):\n${tags}`;
};

/** Byte-stable for a given catalog snapshot, so prompt caching works across a whole import run. */
export const systemPrompt = (catalog: CatalogSnapshot): string => RULES + fmt(catalog);

export const TEXT_TASK = `Parse the recipe text below into one recipe.`;

export const PAGE_TASK = `The image is a photo of one notebook page. It may hold one recipe or several; return one entry in "recipes" per recipe, in page order. For each, first write "rawText": a plain-text transcription of that recipe exactly as written on the page (title, ingredients, method, notes). Then fill in the structured fields from your transcription. The photo is the source of truth.

A rough typed transcription of the page is also given as a hint only. It can contain mistakes or omissions. Where the photo and the hint disagree on something that matters (an amount, an ingredient, a step), follow the photo and add a warning such as "photo: 1 tomato; hint: 2 tomatoes".`;

export const SeedResult = Schema.Struct({
  ingredients: Schema.Array(Schema.Struct({ name: Schema.String, aliases: Schema.Array(Schema.String) })),
});

export const SEED_RULES = `You build the canonical ingredient list for a family recipe site. The input is raw ingredient lines (with quantities, preparation and typos) taken from handwritten recipes: mostly South Indian home cooking, plus Western and other clippings.

For every distinct ingredient mentioned, output one entry:
- "name": a short canonical English name in lower case ("toor dal", "poppy seeds", "byadgi chilies", "onion").
- "aliases": other spellings, regional names and plural/singular forms that appear in the lines or are common ("tur dal", "pigeon peas", "gagase", "khus khus"). Do not repeat the name.
Rules:
- Strip quantities, units and preparation words ("2 tomatoes, chopped" -> tomato).
- Merge the same ingredient across spellings (toor dal / tur dal / thuvaram paruppu). Keep genuinely different ingredients separate (red chilies vs byadgi chilies; urad dal vs toor dal; butter vs ghee).
- Reuse a name from the existing catalog below instead of inventing a new one for the same ingredient; list the new spelling as an alias of it.
- Skip lines that are not ingredients (pan sizes, "water", serving notes). Plain water and salt are ingredients and should be kept.`;

export const seedPrompt = (c: CatalogSnapshot): string =>
  `${SEED_RULES}\n\nExisting catalog (name | aliases):\n${c.ingredients.length ? c.ingredients.map((i) => `${i.name}${i.aliases.length ? ` | ${i.aliases.join(", ")}` : ""}`).join("\n") : "(empty)"}`;
