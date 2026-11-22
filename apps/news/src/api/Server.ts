import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { Feed } from "../repos/Feed";
import { Api } from "./Api";

const StoriesHandlers = HttpApiBuilder.group(
  Api,
  "stories",
  Effect.fn(function* (handlers) {
    const feed = yield* Feed;
    const clamp = (n: number | undefined, dflt: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n ?? dflt)));
    return handlers.handleAll({
      list: ({ query }) =>
        feed.list({
          limit: clamp(query.limit, 30, 1, 100),
          minOutlets: clamp(query.minOutlets, 3, 1, 50),
          sort: query.sort ?? "coverage",
          hours: clamp(query.hours, 48, 1, 24 * 90),
          blindspotOnly: query.blindspot === "true",
        }),
      get: ({ params }) =>
        feed.get(params.id).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new HttpApiError.NotFound()), onSome: Effect.succeed })),
        ),
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) => Effect.succeed(handlers.handleAll({ health: () => Effect.void })));

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(Layer.provide([StoriesHandlers, SystemHandlers]));
const Ui = HttpRouter.add(
  "GET",
  "/",
  Effect.promise(() => Bun.file(new URL("../web/index.html", import.meta.url)).text()).pipe(Effect.map((html) => HttpServerResponse.html(html))),
);

/** The HTTP server: JSON API under /stories, the one-page UI at /. Needs `Feed`. */
export const serve = (port: number) =>
  HttpRouter.serve(Layer.mergeAll(ApiRoutes, Ui)).pipe(Layer.provide(BunHttpServer.layer({ port })));
