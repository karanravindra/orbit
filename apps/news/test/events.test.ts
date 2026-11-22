import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { serve } from "../src/api/Server";
import { PgLive } from "../src/db/Db";
import { STORIES_CHANGED } from "../src/pipeline/Cluster";
import { SUMMARY_READY } from "../src/pipeline/Summaries";
import { Feed } from "../src/repos/Feed";
import { dbUp } from "./helpers";

// A real server on a random port, a real Postgres NOTIFY, a real HTTP client reading the event stream.
test.skipIf(!dbUp)("GET /events streams `stories` and `summary` events when Postgres notifies, and keeps the stream open", async () => {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const Server = serve(port).pipe(Layer.provide(Feed.layer.pipe(Layer.provideMerge(PgLive))));

  const received = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Server);
      const sql = yield* SqlClient.SqlClient;
      const ctrl = new AbortController();
      const res = yield* Effect.promise(() => fetch(`http://localhost:${port}/events`, { signal: ctrl.signal }));
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      // NOTIFY may beat LISTEN registration, so keep notifying until the event arrives.
      const pump = Effect.promise(async () => {
        const deadline = Date.now() + 8000;
        let read: ReturnType<typeof reader.read> | null = null; // keep one read in flight: a read that loses a race would still swallow its chunk
        while (!(text.includes("event: stories") && text.includes("event: summary")) && Date.now() < deadline) {
          read ??= reader.read();
          const next = await Promise.race([read, Bun.sleep(150).then(() => null)]);
          if (next === null) continue;
          read = null;
          if (next.done) break;
          text += dec.decode(next.value);
        }
      });
      const notifier = Effect.gen(function* () {
        while (true) {
          yield* sql`select pg_notify(${STORIES_CHANGED}, ${JSON.stringify({ joined: 3, seeded: 1, merges: 0 })})`;
          yield* sql`select pg_notify(${SUMMARY_READY}, ${JSON.stringify({ id: 42 })})`;
          yield* Effect.sleep("200 millis");
        }
      });
      yield* Effect.raceFirst(pump, notifier);
      ctrl.abort();
      return { text, contentType: res.headers.get("content-type"), cache: res.headers.get("cache-control") };
    }).pipe(Effect.scoped, Effect.provide(PgLive), Effect.orDie),
  );

  expect(received.contentType).toContain("text/event-stream");
  expect(received.cache).toBe("no-cache");
  expect(received.text).toContain("retry: 3000");
  expect(received.text).toContain('event: stories\ndata: {"joined":3,"seeded":1,"merges":0}');
  expect(received.text).toContain('event: summary\ndata: {"id":42}');
});
