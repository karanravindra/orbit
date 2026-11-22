import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { cli } from "./cli";
import { SqliteLive } from "./db/Db";
import { Parser } from "./parse/Parser";
import { Ingredients } from "./repos/Ingredients";
import { Recipes } from "./repos/Recipes";

const Infra = Layer.mergeAll(SqliteLive, FetchHttpClient.layer, BunServices.layer);

const AppLayer = Layer.mergeAll(Recipes.layer.pipe(Layer.provideMerge(Ingredients.layer)), Parser.layer).pipe(Layer.provideMerge(Infra));

cli.pipe(Effect.provide(AppLayer), BunRuntime.runMain);
