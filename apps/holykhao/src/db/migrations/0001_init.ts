import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`create table recipes (
    id integer primary key,
    slug text not null unique,
    title text not null,
    summary text,
    raw_text text not null,
    source_ref text unique,
    attribution text,
    servings text,
    prep_minutes integer,
    cook_minutes integer,
    notes text,
    status text not null default 'draft' check (status in ('draft', 'published')),
    parse_warnings text,
    parsed_at text,
    parse_model text,
    created_at text not null default (datetime('now')),
    updated_at text not null default (datetime('now')),
    published_at text
  )`;
  yield* sql`create index recipes_status on recipes (status, published_at)`;

  yield* sql`create table ingredient_sections (
    id integer primary key,
    recipe_id integer not null references recipes (id) on delete cascade,
    position integer not null,
    title text
  )`;
  yield* sql`create index ingredient_sections_recipe on ingredient_sections (recipe_id, position)`;

  yield* sql`create table ingredients (
    id integer primary key,
    slug text not null unique,
    name text not null unique,
    reviewed integer not null default 0
  )`;

  yield* sql`create table ingredient_aliases (
    alias text primary key,
    ingredient_id integer not null references ingredients (id) on delete cascade
  )`;
  yield* sql`create index ingredient_aliases_ingredient on ingredient_aliases (ingredient_id)`;

  yield* sql`create table recipe_ingredients (
    id integer primary key,
    section_id integer not null references ingredient_sections (id) on delete cascade,
    position integer not null,
    ingredient_id integer references ingredients (id),
    quantity text,
    unit text,
    item text not null,
    note text,
    optional integer not null default 0
  )`;
  yield* sql`create index recipe_ingredients_section on recipe_ingredients (section_id, position)`;
  yield* sql`create index recipe_ingredients_ingredient on recipe_ingredients (ingredient_id)`;

  yield* sql`create table steps (
    id integer primary key,
    recipe_id integer not null references recipes (id) on delete cascade,
    position integer not null,
    text text not null
  )`;
  yield* sql`create index steps_recipe on steps (recipe_id, position)`;

  yield* sql`create table tags (
    id integer primary key,
    slug text not null unique,
    name text not null,
    kind text not null check (kind in ('course', 'cuisine', 'diet', 'occasion'))
  )`;
  yield* sql`create table recipe_tags (
    recipe_id integer not null references recipes (id) on delete cascade,
    tag_id integer not null references tags (id) on delete cascade,
    primary key (recipe_id, tag_id)
  )`;
  yield* sql`create index recipe_tags_tag on recipe_tags (tag_id)`;

  // Regular (content-storing) FTS5 table so per-row DELETE works. Rows are written by the app, not triggers.
  yield* sql`create virtual table recipes_fts using fts5(
    title, summary, ingredients, steps, tags,
    tokenize = 'porter unicode61 remove_diacritics 2'
  )`;
});
