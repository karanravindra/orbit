import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { TagKind } from "../domain/Recipe";
import { Recipes, type RecipeView } from "./Recipes";

export interface Card {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly status: "draft" | "published";
}

export interface TagGroup {
  readonly kind: TagKind;
  readonly tags: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly count: number }>;
}

/** Turn what a person typed into a safe FTS5 query: every word is a prefix term, all must match. */
export const ftsQuery = (q: string): string | undefined => {
  const words = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : undefined;
};

/** Read-only queries for the public pages. With `includeDrafts` (serve --drafts) drafts are visible too. */
export class Site extends Context.Service<Site, {
  readonly includeDrafts: boolean;
  home: Effect.Effect<{ readonly recent: ReadonlyArray<Card>; readonly groups: ReadonlyArray<TagGroup> }>;
  recipe(slug: string): Effect.Effect<RecipeView | undefined>;
  byTag(slug: string): Effect.Effect<{ readonly name: string; readonly kind: TagKind; readonly recipes: ReadonlyArray<Card> } | undefined>;
  byIngredient(slug: string): Effect.Effect<{ readonly name: string; readonly recipes: ReadonlyArray<Card> } | undefined>;
  search(q: string): Effect.Effect<ReadonlyArray<Card>>;
}>()("holykhao/Site") {
  static readonly make = (includeDrafts: boolean) =>
    Layer.effect(
      Site,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const recipes = yield* Recipes;
        const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);
        const visible = includeDrafts ? sql`1 = 1` : sql`r.status = 'published'`;

        const home = die(
          Effect.gen(function* () {
            const recent = yield* sql<Card>`
              select r.slug, r.title, r.summary, r.status from recipes r where ${visible}
              order by coalesce(r.published_at, r.created_at) desc, r.id desc limit 24`;
            const rows = yield* sql<{ kind: TagKind; slug: string; name: string; count: number }>`
              select t.kind, t.slug, t.name, count(*) as count
              from tags t join recipe_tags rt on rt.tag_id = t.id join recipes r on r.id = rt.recipe_id
              where ${visible} group by t.id order by t.kind, t.name`;
            const groups: TagGroup[] = [];
            for (const kind of ["course", "cuisine", "diet", "occasion"] as const) {
              const tags = rows.filter((r) => r.kind === kind).map(({ slug, name, count }) => ({ slug, name, count }));
              if (tags.length) groups.push({ kind, tags });
            }
            return { recent, groups };
          }),
        );

        const byTag = Effect.fn("Site.byTag")(function* (slug: string) {
          const [tag] = yield* sql<{ id: number; name: string; kind: TagKind }>`select id, name, kind from tags where slug = ${slug}`;
          if (!tag) return undefined;
          const list = yield* sql<Card>`
            select r.slug, r.title, r.summary, r.status from recipes r join recipe_tags rt on rt.recipe_id = r.id
            where rt.tag_id = ${tag.id} and ${visible} order by r.title`;
          return { name: tag.name, kind: tag.kind, recipes: list };
        }, die);

        const byIngredient = Effect.fn("Site.byIngredient")(function* (slug: string) {
          const [ing] = yield* sql<{ id: number; name: string }>`select id, name from ingredients where slug = ${slug}`;
          if (!ing) return undefined;
          const list = yield* sql<Card>`
            select distinct r.slug, r.title, r.summary, r.status from recipes r
            join ingredient_sections s on s.recipe_id = r.id join recipe_ingredients ri on ri.section_id = s.id
            where ri.ingredient_id = ${ing.id} and ${visible} order by r.title`;
          return { name: ing.name, recipes: list };
        }, die);

        const search = Effect.fn("Site.search")(function* (q: string) {
          const match = ftsQuery(q);
          if (!match) return [];
          // Column weights: title, summary, ingredients, steps, tags.
          return yield* sql<Card>`
            select r.slug, r.title, r.summary, r.status
            from recipes_fts join recipes r on r.id = recipes_fts.rowid
            where recipes_fts match ${match} and ${visible}
            order by bm25(recipes_fts, 10.0, 3.0, 4.0, 1.0, 3.0) limit 60`;
        }, die);

        return Site.of({ includeDrafts, home, recipe: (slug) => recipes.bySlug(slug, includeDrafts), byTag, byIngredient, search });
      }),
    );
}
