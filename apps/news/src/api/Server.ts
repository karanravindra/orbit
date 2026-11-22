import { BunHttpServer } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { STORIES_CHANGED } from "../pipeline/Cluster";
import { Feed } from "../repos/Feed";
import { TOPICS, isTopic } from "../topics/taxonomy";
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
          sort: query.sort ?? "top",
          hours: clamp(query.hours, 48, 1, 24 * 90),
          blindspotOnly: query.blindspot === "true",
          topic: query.topic && isTopic(query.topic) ? query.topic : undefined,
        }),
      topics: ({ query }) =>
        feed.topics({ minOutlets: clamp(query.minOutlets, 3, 1, 50), hours: clamp(query.hours, 48, 1, 24 * 90) }).pipe(
          Effect.map((rows) => rows.map((r) => ({ ...r, label: TOPICS.find((t) => t.id === r.topic)?.label ?? "Unsorted" }))),
        ),
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

const KEEPALIVE_EVERY = "20 seconds";

/**
 * Server-sent events: one `stories` event per clustering run that changed anything (payload: counts), plus a comment
 * every 20 s so proxies keep the connection open. The Postgres LISTEN lives exactly as long as the response stream, and
 * a dropped connection simply ends the stream; the browser's EventSource reconnects by itself.
 */
export const events = Effect.gen(function* () {
  const pg = yield* PgClient.PgClient;
  const notifications = Stream.unwrap(pg.listen(STORIES_CHANGED).pipe(Effect.map((q) => Stream.fromQueue(q))));
  const body = Stream.merge(
    notifications.pipe(Stream.map((n) => `event: stories\ndata: ${n.payload}\n\n`)),
    Stream.tick(KEEPALIVE_EVERY).pipe(Stream.map(() => ": keepalive\n\n")),
  ).pipe(Stream.prepend(["retry: 3000\n\n: connected\n\n"]), Stream.encodeText);
  return HttpServerResponse.stream(body, { contentType: "text/event-stream", headers: { "cache-control": "no-cache", "x-accel-buffering": "no" } });
});

/** The HTTP server: JSON API under /stories, the one-page UI at /. Needs `Feed` and `PgClient`. */
export const serve = (port: number) =>
  HttpRouter.serve(Layer.mergeAll(ApiRoutes, Ui, HttpRouter.add("GET", "/events", events))).pipe(Layer.provide(BunHttpServer.layer({ port, gracefulShutdownTimeout: "1 second" })));
