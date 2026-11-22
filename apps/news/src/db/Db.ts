import { PgClient, PgMigrator } from "@effect/sql-pg";
import { Config, Redacted, String as Str } from "effect";

const DEFAULT_URL = "postgres://news:news@localhost:5433/news";

/** Provides `SqlClient` (and `PgClient`). Rows come back camelCased, inserts are snake_cased. */
export const PgLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make(DEFAULT_URL))),
  transformResultNames: Config.succeed(Str.snakeToCamel),
  transformQueryNames: Config.succeed(Str.camelToSnake),
});

/** Applies pending `migrations/NNNN_name.ts` files (each default-exports an Effect). */
export const migrate = PgMigrator.run({
  loader: PgMigrator.fromFileSystem(new URL("./migrations", import.meta.url).pathname),
});
