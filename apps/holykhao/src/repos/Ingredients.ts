import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { slugify, type CatalogSnapshot, type ParsedIngredient } from "../domain/Recipe";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface IngredientRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly reviewed: number;
  readonly uses: number;
}

/** Canonical ingredients and their aliases. DB failures are defects. */
export class Ingredients extends Context.Service<Ingredients, {
  /** Ingredients + aliases + tags as they are right now (for the system prompt). */
  catalog: Effect.Effect<CatalogSnapshot>;
  /** Resolve a parsed ingredient line to an ingredient id, creating it (unreviewed) if it is new. Run inside a transaction. */
  resolve(line: ParsedIngredient): Effect.Effect<number>;
  /** Add an ingredient with aliases; no-op if the name already exists. Returns its id. */
  ensure(name: string, aliases: ReadonlyArray<string>, reviewed: boolean): Effect.Effect<number>;
  list(onlyUnreviewed: boolean): Effect.Effect<ReadonlyArray<IngredientRow & { readonly aliases: ReadonlyArray<string> }>>;
  markReviewed(slug: string): Effect.Effect<boolean>;
  /** Move all lines and aliases of `from` onto `into` and delete `from`. */
  merge(from: string, into: string): Effect.Effect<boolean>;
}>()("holykhao/Ingredients") {
  static readonly layer = Layer.effect(
    Ingredients,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const die = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.orDie(e);

      const catalog = die(
        Effect.gen(function* () {
          const ings = yield* sql<{ id: number; slug: string; name: string }>`select id, slug, name from ingredients order by name`;
          const aliases = yield* sql<{ alias: string; ingredientId: number }>`select alias, ingredient_id from ingredient_aliases order by alias`;
          const tags = yield* sql<{ slug: string; name: string; kind: "course" | "cuisine" | "diet" | "occasion" }>`select slug, name, kind from tags order by kind, name`;
          const byId = new Map<number, string[]>();
          for (const a of aliases) (byId.get(a.ingredientId) ?? byId.set(a.ingredientId, []).get(a.ingredientId)!).push(a.alias);
          return {
            ingredients: ings.map((i) => ({ slug: i.slug, name: i.name, aliases: (byId.get(i.id) ?? []).filter((a) => a !== norm(i.name)) })),
            tags,
          } satisfies CatalogSnapshot;
        }),
      );

      const addAliases = (id: number, names: ReadonlyArray<string>) =>
        Effect.forEach(names.map(norm).filter(Boolean), (alias) => sql`insert or ignore into ingredient_aliases (alias, ingredient_id) values (${alias}, ${id})`, { discard: true });

      const idByAlias = (name: string) =>
        Effect.gen(function* () {
          const n = norm(name);
          const [a] = yield* sql<{ ingredientId: number }>`select ingredient_id from ingredient_aliases where alias = ${n}`;
          if (a) return a.ingredientId;
          const [i] = yield* sql<{ id: number }>`select id from ingredients where lower(name) = ${n} or slug = ${slugify(n)}`;
          return i?.id;
        });

      const ensure = Effect.fn("Ingredients.ensure")(function* (name: string, aliases: ReadonlyArray<string>, reviewed: boolean) {
        const clean = name.trim();
        const existing = yield* idByAlias(clean);
        if (existing !== undefined) {
          yield* addAliases(existing, aliases);
          return existing;
        }
        let slug = slugify(clean);
        const [clash] = yield* sql<{ id: number }>`select id from ingredients where slug = ${slug}`;
        if (clash) slug = `${slug}-${Date.now().toString(36)}`;
        const [row] = yield* sql<{ id: number }>`insert into ingredients (slug, name, reviewed) values (${slug}, ${clean}, ${reviewed ? 1 : 0}) returning id`;
        yield* addAliases(row!.id, [clean, ...aliases]);
        return row!.id;
      }, die);

      const resolve = Effect.fn("Ingredients.resolve")(function* (line: ParsedIngredient) {
        // The model's canonical name first, then what the recipe literally says; otherwise it is a new (unreviewed) ingredient.
        const canon = line.ingredient.trim();
        if (canon) {
          const hit = yield* idByAlias(canon);
          if (hit !== undefined) return hit;
        }
        const byItem = yield* idByAlias(line.item);
        if (byItem !== undefined) return byItem;
        return yield* ensure(canon || line.item.trim(), [line.item], false);
      }, die);

      const list = Effect.fn("Ingredients.list")(function* (onlyUnreviewed: boolean) {
        const rows = yield* sql<IngredientRow>`
          select i.id, i.slug, i.name, i.reviewed, (select count(*) from recipe_ingredients r where r.ingredient_id = i.id) as uses
          from ingredients i ${onlyUnreviewed ? sql`where i.reviewed = 0` : sql``} order by i.name`;
        const aliases = yield* sql<{ alias: string; ingredientId: number }>`select alias, ingredient_id from ingredient_aliases order by alias`;
        const byId = new Map<number, string[]>();
        for (const a of aliases) (byId.get(a.ingredientId) ?? byId.set(a.ingredientId, []).get(a.ingredientId)!).push(a.alias);
        return rows.map((r) => ({ ...r, aliases: (byId.get(r.id) ?? []).filter((a) => a !== norm(r.name)) }));
      }, die);

      const markReviewed = Effect.fn("Ingredients.markReviewed")(function* (slug: string) {
        const rows = yield* sql<{ id: number }>`update ingredients set reviewed = 1 where slug = ${slug} returning id`;
        return rows.length > 0;
      }, die);

      const merge = Effect.fn("Ingredients.merge")(function* (from: string, into: string) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [a] = yield* sql<{ id: number; name: string }>`select id, name from ingredients where slug = ${from}`;
            const [b] = yield* sql<{ id: number }>`select id from ingredients where slug = ${into}`;
            if (!a || !b || a.id === b.id) return false;
            yield* sql`update recipe_ingredients set ingredient_id = ${b.id} where ingredient_id = ${a.id}`;
            yield* sql`update or ignore ingredient_aliases set ingredient_id = ${b.id} where ingredient_id = ${a.id}`;
            yield* sql`delete from ingredient_aliases where ingredient_id = ${a.id}`;
            yield* sql`delete from ingredients where id = ${a.id}`;
            yield* addAliases(b.id, [a.name]);
            yield* sql`update ingredients set reviewed = 1 where id = ${b.id}`;
            return true;
          }),
        );
      }, die);

      return Ingredients.of({ catalog, resolve, ensure, list, markReviewed, merge });
    }),
  );
}
