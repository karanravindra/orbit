import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";
import { migrate } from "./db/Db";
import { PageResult } from "./domain/Recipe";
import { ingredientLines, listPages, loadImage } from "./import/corpus";
import { Parser } from "./parse/Parser";
import { Ingredients } from "./repos/Ingredients";
import { Recipes, type RecipeView } from "./repos/Recipes";
import { Site } from "./repos/Site";
import { serve } from "./web/Server";

const migrateCmd = Command.make("migrate", {}, () =>
  migrate.pipe(
    Effect.flatMap((applied) => Console.log(applied.length ? `applied ${applied.map(([, name]) => name).join(", ")}` : "migrations up to date")),
  ),
).pipe(Command.withDescription("Apply database migrations"));

const statusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [r] = yield* sql<{ drafts: number; published: number; warned: number; unreviewed: number }>`
      select
        (select count(*) from recipes where status = 'draft') as drafts,
        (select count(*) from recipes where status = 'published') as published,
        (select count(*) from recipes where parse_warnings is not null and parse_warnings != '[]') as warned,
        (select count(*) from ingredients where reviewed = 0) as unreviewed`;
    yield* Console.log(`drafts ${r!.drafts} · published ${r!.published} · with warnings ${r!.warned} · unreviewed ingredients ${r!.unreviewed}`);
  }),
).pipe(Command.withDescription("Counts of drafts, published recipes, warnings and unreviewed ingredients"));

const render = (r: RecipeView): string => {
  const out: string[] = [];
  out.push(`${r.title}  [${r.status}]  /r/${r.slug}${r.sourceRef ? `  (${r.sourceRef})` : ""}`);
  const meta = [r.servings && `serves ${r.servings}`, r.prepMinutes != null && `prep ${r.prepMinutes}m`, r.cookMinutes != null && `cook ${r.cookMinutes}m`, r.attribution && `via ${r.attribution}`].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "));
  if (r.summary) out.push(r.summary);
  if (r.tags.length) out.push(`tags: ${r.tags.map((t) => `${t.kind}:${t.name}`).join(", ")}`);
  for (const s of r.sections) {
    out.push("", s.title ? `${s.title}:` : "Ingredients:");
    for (const l of s.ingredients) {
      const amount = [l.quantity, l.unit].filter(Boolean).join(" ");
      out.push(`  - ${[amount, l.item].filter(Boolean).join(" ")}${l.note ? `, ${l.note}` : ""}${l.optional ? " (optional)" : ""}${l.ingredientSlug ? `  → ${l.ingredientSlug}` : ""}`);
    }
  }
  if (r.steps.length) out.push("", "Method:", ...r.steps.map((s, i) => `  ${i + 1}. ${s}`));
  if (r.notes) out.push("", `Notes: ${r.notes}`);
  if (r.warnings.length) out.push("", "Warnings:", ...r.warnings.map((w) => `  ! ${w}`));
  return out.join("\n");
};

const addCmd = Command.make("add", { file: Argument.String("file").pipe(Argument.optional) }, ({ file }) =>
  Effect.gen(function* () {
    const parser = yield* Parser;
    const ingredients = yield* Ingredients;
    const recipes = yield* Recipes;
    const path = Option.getOrUndefined(file);
    const text = yield* Effect.promise(() => (path && path !== "-" ? Bun.file(path).text() : Bun.stdin.text()));
    if (!text.trim()) return yield* Console.error("no text given");
    const parsed = yield* parser.parseText(text, yield* ingredients.catalog);
    const saved = yield* recipes.saveParsed(parsed, { model: parser.model });
    yield* Console.log(`saved draft ${saved.slug}${parsed.warnings.length ? ` (${parsed.warnings.length} warnings)` : ""}`);
  }),
).pipe(Command.withDescription("Create a draft recipe from raw text (file argument, or stdin)"));

const showCmd = Command.make("show", { slug: Argument.String("slug") }, ({ slug }) =>
  Effect.gen(function* () {
    const r = yield* (yield* Recipes).bySlug(slug, true);
    yield* Console.log(r ? render(r) : `no recipe "${slug}"`);
  }),
).pipe(Command.withDescription("Print a structured recipe, with warnings"));

const listCmd = Command.make(
  "list",
  {
    status: Flag.String("status").pipe(Flag.withDescription("draft | published"), Flag.optional),
    warnings: Flag.Boolean("warnings").pipe(Flag.withDescription("Only recipes with parse warnings"), Flag.withDefault(false)),
  },
  ({ status, warnings }) =>
    Effect.gen(function* () {
      const s = Option.getOrUndefined(status);
      const rows = yield* (yield* Recipes).list({ status: s === "draft" || s === "published" ? s : undefined, withWarnings: warnings });
      for (const r of rows) yield* Console.log(`${r.status === "published" ? "●" : "○"} ${r.slug}  ${r.title}${r.warningCount ? `  (${r.warningCount} warnings)` : ""}`);
      yield* Console.log(`${rows.length} recipes`);
    }),
).pipe(Command.withDescription("List recipes"));

const publishCmd = Command.make(
  "publish",
  {
    slugs: Argument.String("slug").pipe(Argument.variadic({ min: 0 })),
    allClean: Flag.Boolean("all-clean").pipe(Flag.withDescription("Publish every draft that has no warnings"), Flag.withDefault(false)),
  },
  ({ slugs, allClean }) =>
    Effect.gen(function* () {
      const n = yield* (yield* Recipes).publish(slugs, allClean);
      yield* Console.log(`published ${n}`);
    }),
).pipe(Command.withDescription("Publish drafts by slug, or all clean drafts"));

const unpublishCmd = Command.make("unpublish", { slug: Argument.String("slug") }, ({ slug }) =>
  Effect.gen(function* () {
    yield* Console.log((yield* (yield* Recipes).unpublish(slug)) ? `unpublished ${slug}` : `${slug} was not published`);
  }),
).pipe(Command.withDescription("Move a published recipe back to draft"));

const ingReviewCmd = Command.make("review", { all: Flag.Boolean("all").pipe(Flag.withDefault(false)) }, ({ all }) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Ingredients).list(!all);
    for (const r of rows) yield* Console.log(`${r.reviewed ? "✓" : "?"} ${r.slug}  "${r.name}"  used ${r.uses}×${r.aliases.length ? `  aliases: ${r.aliases.join(", ")}` : ""}`);
    yield* Console.log(`${rows.length} ingredients${all ? "" : " unreviewed"}`);
  }),
).pipe(Command.withDescription("List ingredients (unreviewed by default)"));

const ingDoneCmd = Command.make("approve", { slugs: Argument.String("slug").pipe(Argument.variadic({ min: 1 })) }, ({ slugs }) =>
  Effect.gen(function* () {
    const ingredients = yield* Ingredients;
    for (const s of slugs) yield* Console.log((yield* ingredients.markReviewed(s)) ? `approved ${s}` : `no ingredient ${s}`);
  }),
).pipe(Command.withDescription("Mark ingredients as reviewed"));

const ingMergeCmd = Command.make("merge", { from: Argument.String("from"), into: Argument.String("into") }, ({ from, into }) =>
  Effect.gen(function* () {
    yield* Console.log((yield* (yield* Ingredients).merge(from, into)) ? `merged ${from} into ${into}` : "nothing merged (check both slugs)");
  }),
).pipe(Command.withDescription("Merge a duplicate ingredient into another"));

const ingSeedCmd = Command.make(
  "seed",
  {
    dir: Argument.String("dir"),
    chunk: Flag.Int("chunk").pipe(Flag.withDescription("Ingredient lines per Claude call"), Flag.withDefault(300)),
  },
  ({ dir, chunk }) =>
    Effect.gen(function* () {
      const parser = yield* Parser;
      const ingredients = yield* Ingredients;
      const lines = yield* ingredientLines(dir);
      const chunks = Array.from({ length: Math.ceil(lines.length / chunk) }, (_, i) => lines.slice(i * chunk, (i + 1) * chunk));
      yield* Console.log(`${lines.length} distinct ingredient lines in ${chunks.length} calls`);
      // Sequential on purpose: each chunk sees the catalog the previous one built, so names get reused.
      for (const [i, part] of chunks.entries()) {
        const found = yield* parser.canonicalize(part, yield* ingredients.catalog);
        for (const f of found) yield* ingredients.ensure(f.name, f.aliases, false);
        yield* Console.log(`  chunk ${i + 1}/${chunks.length}: ${found.length} ingredients`);
      }
      yield* Console.log(`catalog now has ${(yield* ingredients.catalog).ingredients.length} ingredients; review with: ingredients review`);
    }),
).pipe(Command.withDescription("One-time: canonicalize the ingredient lines of the typed recipes into the catalog"));

const ingredientsCmd = Command.make("ingredients").pipe(
  Command.withDescription("Canonical ingredient catalog"),
  Command.withSubcommands([ingSeedCmd, ingReviewCmd, ingDoneCmd, ingMergeCmd]),
);

const serveCmd = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(Flag.withDescription("HTTP port"), Flag.withDefault(3000)),
    drafts: Flag.Boolean("drafts").pipe(Flag.withDescription("Also show drafts (local preview)"), Flag.withDefault(false)),
  },
  ({ port, drafts }) => Layer.launch(serve(port).pipe(Layer.provide(Site.make(drafts)))),
).pipe(Command.withDescription("Serve the public site"));

const importJsonCmd = Command.make(
  "import-json",
  {
    dir: Argument.String("dir"),
    source: Flag.String("source").pipe(Flag.withDescription("Recorded as the parse model, e.g. agent:haiku"), Flag.withDefault("agent")),
  },
  ({ dir, source }) =>
    Effect.gen(function* () {
      const recipes = yield* Recipes;
      const files = (yield* Effect.promise(() => readdir(dir))).filter((f) => /^recipe_\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)));
      let ok = 0;
      let made = 0;
      for (const f of files) {
        const id = f.replace(".json", "");
        const result = yield* Effect.promise(() => Bun.file(`${dir}/${f}`).text()).pipe(
          Effect.flatMap((t) => Effect.try(() => JSON.parse(t) as unknown)),
          Effect.flatMap(Schema.decodeUnknownEffect(PageResult)),
          Effect.result,
        );
        if (result._tag === "Failure") {
          yield* Console.error(`✗ ${id}: ${String((result.failure as { message?: string }).message ?? result.failure).slice(0, 200)}`);
          continue;
        }
        const slugs: string[] = [];
        for (const [i, r] of result.success.recipes.entries()) slugs.push((yield* recipes.saveParsed(r, { sourceRef: `${id}#${i + 1}`, model: source })).slug);
        ok++;
        made += slugs.length;
        const w = result.success.recipes.reduce((n, r) => n + r.warnings.length, 0);
        yield* Console.log(`✓ ${id} → ${slugs.join(", ")}${w ? `  (${w} warnings)` : ""}`);
      }
      yield* Console.log(`done: ${ok}/${files.length} files → ${made} recipes`);
    }),
).pipe(Command.withDescription("Load recipe_N.json files (page results written by an agent) as draft recipes"));

const editCmd = Command.make("edit", { slug: Argument.String("slug") }, ({ slug }) =>
  Effect.gen(function* () {
    const parser = yield* Parser;
    const ingredients = yield* Ingredients;
    const recipes = yield* Recipes;
    const r = yield* recipes.bySlug(slug, true);
    if (!r) return yield* Console.error(`no recipe "${slug}"`);
    const file = join(tmpdir(), `holykhao-${slug}.txt`);
    yield* Effect.promise(() => Bun.write(file, r.rawText));
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const code = yield* Effect.promise(() => Bun.spawn([editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited);
    if (code !== 0) return yield* Console.error(`editor exited with ${code}; nothing changed`);
    const edited = yield* Effect.promise(() => Bun.file(file).text());
    if (edited.trim() === r.rawText.trim()) return yield* Console.log("no changes");
    const parsed = yield* parser.parseText(edited, yield* ingredients.catalog);
    yield* recipes.saveParsed(parsed, { recipeId: r.id, model: parser.model });
    yield* Console.log(`updated ${slug} (${r.status})${parsed.warnings.length ? `, ${parsed.warnings.length} warnings` : ""}`);
  }),
).pipe(Command.withDescription("Edit a recipe's raw text in $EDITOR, then re-parse it"));

const reparseCmd = Command.make(
  "reparse",
  {
    slugs: Argument.String("slug").pipe(Argument.variadic({ min: 0 })),
    all: Flag.Boolean("all").pipe(Flag.withDescription("Every recipe"), Flag.withDefault(false)),
    warnings: Flag.Boolean("warnings").pipe(Flag.withDescription("Every recipe that has warnings"), Flag.withDefault(false)),
    concurrency: Flag.Int("concurrency").pipe(Flag.withDefault(4)),
  },
  ({ slugs, all, warnings, concurrency }) =>
    Effect.gen(function* () {
      const parser = yield* Parser;
      const ingredients = yield* Ingredients;
      const recipes = yield* Recipes;
      const targets = all || warnings ? (yield* recipes.list({ withWarnings: warnings })).map((r) => r.slug) : slugs;
      if (targets.length === 0) return yield* Console.error("give slugs, --all or --warnings");
      const catalog = yield* ingredients.catalog;
      yield* Console.log(`re-parsing ${targets.length} recipes from their raw text`);
      yield* Effect.forEach(
        targets,
        (slug) =>
          Effect.gen(function* () {
            const r = yield* recipes.bySlug(slug, true);
            if (!r) return yield* Console.error(`no recipe "${slug}"`);
            const parsed = yield* parser.parseText(r.rawText, catalog);
            yield* recipes.saveParsed(parsed, { recipeId: r.id, model: parser.model });
            yield* Console.log(`✓ ${slug}${parsed.warnings.length ? `  (${parsed.warnings.length} warnings)` : ""}`);
          }).pipe(Effect.catch((e) => Console.error(`✗ ${slug}: ${e.message}`))),
        { concurrency },
      );
    }),
).pipe(Command.withDescription("Re-run the parser on existing recipes (e.g. after a prompt change)"));

const importCmd = Command.make(
  "import",
  {
    dir: Argument.String("dir"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Import at most this many (new) pages"), Flag.optional),
    pages: Flag.String("pages").pipe(Flag.withDescription("Only these pages, comma-separated (recipe_28,recipe_314)"), Flag.optional),
    concurrency: Flag.Int("concurrency").pipe(Flag.withDescription("Parallel Claude calls"), Flag.withDefault(4)),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Re-import pages that already have recipes"), Flag.withDefault(false)),
  },
  ({ dir, limit, pages, concurrency, force }) =>
    Effect.gen(function* () {
      const parser = yield* Parser;
      const ingredients = yield* Ingredients;
      const recipes = yield* Recipes;
      let todo = yield* listPages(dir);
      const only = Option.map(pages, (p) => new Set(p.split(",").map((x) => x.trim().replace(/\.(png|md)$/, ""))));
      if (Option.isSome(only)) todo = todo.filter((p) => only.value.has(p.id));
      if (!force) {
        const done = yield* recipes.sourceRefs;
        const donePages = new Set([...done].map((r) => r.split("#")[0]));
        todo = todo.filter((p) => !donePages.has(p.id));
      }
      if (Option.isSome(limit)) todo = todo.slice(0, limit.value);
      yield* Console.log(`importing ${todo.length} pages with ${parser.model} (concurrency ${concurrency})`);

      // One frozen snapshot for the whole run: the prompt stays byte-stable (cache hits) and parallel pages see the same catalog.
      const catalog = yield* ingredients.catalog;
      let ok = 0;
      let made = 0;
      let failed = 0;
      yield* Effect.forEach(
        todo,
        (page) =>
          Effect.gen(function* () {
            const image = yield* loadImage(page);
            const parsed = yield* parser.parsePage(image, page.hint, catalog);
            const saved: string[] = [];
            for (const [i, r] of parsed.entries()) saved.push((yield* recipes.saveParsed(r, { sourceRef: `${page.id}#${i + 1}`, model: parser.model })).slug);
            ok++;
            made += saved.length;
            const w = parsed.reduce((n, r) => n + r.warnings.length, 0);
            yield* Console.log(`✓ ${page.id} → ${saved.join(", ")}${w ? `  (${w} warnings)` : ""}`);
          }).pipe(
            Effect.catch((e) => Effect.sync(() => void failed++).pipe(Effect.andThen(Console.error(`✗ ${page.id}: ${e.message}`)))),
          ),
        { concurrency },
      );
      yield* Console.log(`done: ${ok} pages → ${made} recipes, ${failed} failed. Review with: list --warnings`);
    }),
).pipe(Command.withDescription("Import notebook photos (vision) as draft recipes; re-runs skip finished pages"));

export const holykhao = Command.make("holykhao").pipe(
  Command.withDescription("holykhao recipe site"),
  Command.withSubcommands([migrateCmd, statusCmd, addCmd, showCmd, listCmd, publishCmd, unpublishCmd, ingredientsCmd, importCmd, importJsonCmd, editCmd, reparseCmd, serveCmd]),
);

export const cli = holykhao.pipe(Command.run({ version: "0.1.0" }));
