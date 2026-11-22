import { BunHttpServer } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { STORIES_CHANGED } from "../pipeline/Cluster";
import { SUMMARY_READY } from "../pipeline/Summaries";
import { Feed } from "../repos/Feed";
import { TOPICS, isTopic } from "../topics/taxonomy";
import { Api } from "./Api";

const StoriesHandlers = HttpApiBuilder.group(
  Api,
  "stories",
  Effect.fn(function* (handlers) {
    const feed = yield* Feed;
    const writerOn = yield* Effect.orDie(Config.Boolean("SUMMARIES").pipe(Config.withDefault(false)));
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
          // Summaries are written ahead of time, never on a request (the model needs seconds to load). A story opened without
          // one jumps the writer's queue; the page shows the lede meanwhile and is told over /events when it is ready.
          Effect.tap((d) => (writerOn && d.summary === null && d.outlets >= 3 ? feed.wantSummary(d.id) : Effect.void)),
          Effect.map((d) => ({ ...d, summaryPending: writerOn && d.summary === null && d.outlets >= 3 })),
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
 * Server-sent events: one `stories` event per clustering run that changed anything (payload: counts), one `summary` event
 * per summary written (payload: story id), plus a comment
 * every 20 s so proxies keep the connection open. The Postgres LISTEN lives exactly as long as the response stream, and
 * a dropped connection simply ends the stream; the browser's EventSource reconnects by itself.
 */
export const events = Effect.gen(function* () {
  const pg = yield* PgClient.PgClient;
  const channel = (name: string, event: string) =>
    Stream.unwrap(pg.listen(name).pipe(Effect.map((q) => Stream.fromQueue(q)))).pipe(Stream.map((n) => `event: ${event}\ndata: ${n.payload}\n\n`));
  const body = Stream.mergeAll([
    channel(STORIES_CHANGED, "stories"),
    channel(SUMMARY_READY, "summary"),
    Stream.tick(KEEPALIVE_EVERY).pipe(Stream.map(() => ": keepalive\n\n")),
  ], { concurrency: "unbounded" }).pipe(Stream.prepend(["retry: 3000\n\n: connected\n\n"]), Stream.encodeText);
  return HttpServerResponse.stream(body, { contentType: "text/event-stream", headers: { "cache-control": "no-cache", "x-accel-buffering": "no" } });
});

/** The HTTP server: JSON API under /stories, the one-page UI at /. Needs `Feed` and `PgClient`. */
export const serve = (port: number) =>
  HttpRouter.serve(Layer.mergeAll(ApiRoutes, Ui, HttpRouter.add("GET", "/events", events))).pipe(Layer.provide(BunHttpServer.layer({ port, gracefulShutdownTimeout: "1 second" })));
