import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Config, String as Str } from "effect";

/** Provides `SqlClient`. Rows come back camelCased, inserts are snake_cased. */
export const SqliteLive = SqliteClient.layerConfig({
  filename: Config.String("HOLYKHAO_DB").pipe(Config.withDefault("data/holykhao.db")),
  transformResultNames: Config.succeed(Str.snakeToCamel),
  transformQueryNames: Config.succeed(Str.camelToSnake),
});

/** Applies pending `migrations/NNNN_name.ts` files (each default-exports an Effect). */
export const migrate = SqliteMigrator.run({
  loader: SqliteMigrator.fromFileSystem(new URL("./migrations", import.meta.url).pathname),
});
