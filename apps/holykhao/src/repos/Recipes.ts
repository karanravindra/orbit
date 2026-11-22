import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { slugify, type ParsedRecipe, type TagKind } from "../domain/Recipe";
import { Ingredients } from "./Ingredients";

export interface RecipeView {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly rawText: string;
  readonly sourceRef: string | null;
  readonly attribution: string | null;
  readonly servings: string | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  readonly notes: string | null;
  readonly status: "draft" | "published";
  readonly warnings: ReadonlyArray<string>;
  readonly parsedAt: string | null;
  readonly sections: ReadonlyArray<{
    readonly title: string | null;
    readonly ingredients: ReadonlyArray<{
      readonly quantity: string | null;
      readonly unit: string | null;
      readonly item: string;
      readonly note: string | null;
      readonly optional: boolean;
      readonly ingredientSlug: string | null;
    }>;
  }>;
  readonly steps: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly kind: TagKind }>;
}

export interface RecipeSummary {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly status: "draft" | "published";
  readonly warningCount: number;
}

export interface SaveOptions {
  /** e.g. "recipe_314#2". Makes imports idempotent: the same ref updates the same recipe. */
  readonly sourceRef?: string | null;
  /** Re-parse an existing recipe in place (keeps slug and status). */
  readonly recipeId?: number;
  readonly model: string;
}

/** Recipes and their structure. DB failures are defects. */
export class Recipes extends Context.Service<Recipes, {
  /** Replace a recipe's structure with a parse result in one transaction (creating a draft if it is new). */
  saveParsed(parsed: ParsedRecipe, opts: SaveOptions): Effect.Effect<{ readonly id: number; readonly slug: string; readonly created: boolean }>;
  bySlug(slug: string, includeDrafts: boolean): Effect.Effect<RecipeView | undefined>;
  idBySourceRef(ref: string): Effect.Effect<number | undefined>;
  /** Source refs that already exist, to skip finished pages on import. */
  sourceRefs: Effect.Effect<ReadonlySet<string>>;
  list(opts: { readonly status?: "draft" | "published"; readonly withWarnings?: boolean; readonly limit?: number }): Effect.Effect<ReadonlyArray<RecipeSummary>>;
  /** Publish the given slugs, or every draft without warnings when `allClean`. Returns how many changed. */
  publish(slugs: ReadonlyArray<string>, allClean: boolean): Effect.Effect<number>;
  unpublish(slug: string): Effect.Effect<boolean>;
}>()("holykhao/Recipes") {
  static readonly layer = Layer.effect(
    Recipes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ingredients = yield* Ingredients;
      const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);

      const uniqueSlug = (base: string, selfId: number | undefined) =>
        Effect.gen(function* () {
          for (let n = 1; ; n++) {
            const candidate = n === 1 ? base : `${base}-${n}`;
            const [row] = yield* sql<{ id: number }>`select id from recipes where slug = ${candidate}`;
            if (!row || row.id === selfId) return candidate;
          }
        });

      const tagId = (name: string, kind: TagKind) =>
        Effect.gen(function* () {
          const slug = slugify(name);
          const [row] = yield* sql<{ id: number }>`select id from tags where slug = ${slug}`;
          if (row) return row.id;
          const [made] = yield* sql<{ id: number }>`insert into tags (slug, name, kind) values (${slug}, ${name.trim()}, ${kind}) returning id`;
          return made!.id;
        });

      const saveParsed = Effect.fn("Recipes.saveParsed")(function* (parsed: ParsedRecipe, opts: SaveOptions) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const sourceRef = opts.sourceRef ?? null;
            let id = opts.recipeId;
            if (id === undefined && sourceRef) {
              const [row] = yield* sql<{ id: number }>`select id from recipes where source_ref = ${sourceRef}`;
              id = row?.id;
            }
            const warnings = JSON.stringify(parsed.warnings);
            let created = false;
            let slug: string;
            if (id === undefined) {
              created = true;
              slug = yield* uniqueSlug(slugify(parsed.title), undefined);
              const [row] = yield* sql<{ id: number }>`
                insert into recipes (slug, title, summary, raw_text, source_ref, attribution, servings, prep_minutes, cook_minutes, notes, parse_warnings, parsed_at, parse_model)
                values (${slug}, ${parsed.title}, ${parsed.summary}, ${parsed.rawText}, ${sourceRef}, ${parsed.attribution}, ${parsed.servings}, ${parsed.prepMinutes}, ${parsed.cookMinutes}, ${parsed.notes}, ${warnings}, datetime('now'), ${opts.model})
                returning id`;
              id = row!.id;
            } else {
              const [cur] = yield* sql<{ slug: string }>`select slug from recipes where id = ${id}`;
              slug = cur!.slug;
              yield* sql`
                update recipes set title = ${parsed.title}, summary = ${parsed.summary}, raw_text = ${parsed.rawText}, attribution = ${parsed.attribution},
                  servings = ${parsed.servings}, prep_minutes = ${parsed.prepMinutes}, cook_minutes = ${parsed.cookMinutes}, notes = ${parsed.notes},
                  parse_warnings = ${warnings}, parsed_at = datetime('now'), parse_model = ${opts.model}, updated_at = datetime('now')
                where id = ${id}`;
              // Children are deleted explicitly rather than relying on foreign_keys being enabled.
              yield* sql`delete from recipe_ingredients where section_id in (select id from ingredient_sections where recipe_id = ${id})`;
              yield* sql`delete from ingredient_sections where recipe_id = ${id}`;
              yield* sql`delete from steps where recipe_id = ${id}`;
              yield* sql`delete from recipe_tags where recipe_id = ${id}`;
            }
            const recipeId = id;

            const ftsIngredients: string[] = [];
            for (const [si, section] of parsed.sections.entries()) {
              if (section.ingredients.length === 0 && !section.title) continue;
              const [sec] = yield* sql<{ id: number }>`insert into ingredient_sections (recipe_id, position, title) values (${recipeId}, ${si}, ${section.title}) returning id`;
              for (const [li, line] of section.ingredients.entries()) {
                const ingredientId = yield* ingredients.resolve(line);
                yield* sql`
                  insert into recipe_ingredients (section_id, position, ingredient_id, quantity, unit, item, note, optional)
                  values (${sec!.id}, ${li}, ${ingredientId}, ${line.quantity}, ${line.unit}, ${line.item}, ${line.note}, ${/\boptional\b/i.test(line.note ?? "") ? 1 : 0})`;
                // Index the canonical name and its aliases too, so "pigeon peas" finds a recipe written as "toor dal".
                const [ing] = yield* sql<{ text: string }>`
                  select i.name || ' ' || coalesce((select group_concat(alias, ' ') from ingredient_aliases where ingredient_id = i.id), '') as text
                  from ingredients i where i.id = ${ingredientId}`;
                ftsIngredients.push(line.item, ing?.text ?? "");
              }
            }
            for (const [i, text] of parsed.steps.entries()) {
              yield* sql`insert into steps (recipe_id, position, text) values (${recipeId}, ${i}, ${text})`;
            }
            const tagNames: string[] = [];
            for (const t of parsed.tags) {
              const tid = yield* tagId(t.name, t.kind);
              yield* sql`insert or ignore into recipe_tags (recipe_id, tag_id) values (${recipeId}, ${tid})`;
              tagNames.push(t.name);
            }

            yield* sql`delete from recipes_fts where rowid = ${recipeId}`;
            yield* sql`
              insert into recipes_fts (rowid, title, summary, ingredients, steps, tags)
              values (${recipeId}, ${parsed.title}, ${parsed.summary ?? ""}, ${[...new Set(ftsIngredients)].join(" ")}, ${parsed.steps.join(" ")}, ${tagNames.join(" ")})`;

            return { id: recipeId, slug, created };
          }),
        );
      }, die);

      const bySlug = Effect.fn("Recipes.bySlug")(function* (slug: string, includeDrafts: boolean) {
        const [r] = yield* sql<{
          id: number; slug: string; title: string; summary: string | null; rawText: string; sourceRef: string | null; attribution: string | null;
          servings: string | null; prepMinutes: number | null; cookMinutes: number | null; notes: string | null; status: "draft" | "published";
          parseWarnings: string | null; parsedAt: string | null;
        }>`select id, slug, title, summary, raw_text, source_ref, attribution, servings, prep_minutes, cook_minutes, notes, status, parse_warnings, parsed_at
           from recipes where slug = ${slug} ${includeDrafts ? sql`` : sql`and status = 'published'`}`;
        if (!r) return undefined;
        const sections = yield* sql<{ id: number; title: string | null }>`select id, title from ingredient_sections where recipe_id = ${r.id} order by position`;
        const lines = yield* sql<{
          sectionId: number; quantity: string | null; unit: string | null; item: string; note: string | null; optional: number; ingredientSlug: string | null;
        }>`select ri.section_id, ri.quantity, ri.unit, ri.item, ri.note, ri.optional, i.slug as ingredient_slug
           from recipe_ingredients ri
           join ingredient_sections s on s.id = ri.section_id
           left join ingredients i on i.id = ri.ingredient_id
           where s.recipe_id = ${r.id} order by s.position, ri.position`;
        const steps = yield* sql<{ text: string }>`select text from steps where recipe_id = ${r.id} order by position`;
        const tags = yield* sql<{ slug: string; name: string; kind: TagKind }>`
          select t.slug, t.name, t.kind from recipe_tags rt join tags t on t.id = rt.tag_id where rt.recipe_id = ${r.id} order by t.kind, t.name`;
        return {
          id: r.id, slug: r.slug, title: r.title, summary: r.summary, rawText: r.rawText, sourceRef: r.sourceRef, attribution: r.attribution,
          servings: r.servings, prepMinutes: r.prepMinutes, cookMinutes: r.cookMinutes, notes: r.notes, status: r.status,
          warnings: r.parseWarnings ? (JSON.parse(r.parseWarnings) as string[]) : [],
          parsedAt: r.parsedAt,
          sections: sections.map((s) => ({
            title: s.title,
            ingredients: lines.filter((l) => l.sectionId === s.id).map((l) => ({
              quantity: l.quantity, unit: l.unit, item: l.item, note: l.note, optional: l.optional === 1, ingredientSlug: l.ingredientSlug,
            })),
          })),
          steps: steps.map((s) => s.text),
          tags,
        } satisfies RecipeView;
      }, die);

      const idBySourceRef = Effect.fn("Recipes.idBySourceRef")(function* (ref: string) {
        const [row] = yield* sql<{ id: number }>`select id from recipes where source_ref = ${ref}`;
        return row?.id;
      }, die);

      const sourceRefs = die(
        sql<{ sourceRef: string }>`select source_ref from recipes where source_ref is not null`.pipe(
          Effect.map((rows) => new Set(rows.map((r) => r.sourceRef)) as ReadonlySet<string>),
        ),
      );

      const list = Effect.fn("Recipes.list")(function* (opts: { status?: "draft" | "published"; withWarnings?: boolean; limit?: number }) {
        const rows = yield* sql<{ slug: string; title: string; summary: string | null; status: "draft" | "published"; parseWarnings: string | null }>`
          select slug, title, summary, status, parse_warnings from recipes
          where 1 = 1
            ${opts.status ? sql`and status = ${opts.status}` : sql``}
            ${opts.withWarnings ? sql`and parse_warnings is not null and parse_warnings != '[]'` : sql``}
          order by coalesce(published_at, created_at) desc, id desc
          limit ${opts.limit ?? 1000}`;
        return rows.map((r) => ({
          slug: r.slug, title: r.title, summary: r.summary, status: r.status,
          warningCount: r.parseWarnings ? (JSON.parse(r.parseWarnings) as string[]).length : 0,
        }));
      }, die);

      const publish = Effect.fn("Recipes.publish")(function* (slugs: ReadonlyArray<string>, allClean: boolean) {
        let changed = 0;
        if (allClean) {
          const rows = yield* sql`update recipes set status = 'published', published_at = datetime('now')
            where status = 'draft' and (parse_warnings is null or parse_warnings = '[]') returning id`;
          changed += rows.length;
        }
        for (const slug of slugs) {
          const rows = yield* sql`update recipes set status = 'published', published_at = coalesce(published_at, datetime('now')) where slug = ${slug} and status = 'draft' returning id`;
          changed += rows.length;
        }
        return changed;
      }, die);

      const unpublish = Effect.fn("Recipes.unpublish")(function* (slug: string) {
        const rows = yield* sql`update recipes set status = 'draft' where slug = ${slug} and status = 'published' returning id`;
        return rows.length > 0;
      }, die);

      return Recipes.of({ saveParsed, bySlug, idBySourceRef, sourceRefs, list, publish, unpublish });
    }),
  );
}
