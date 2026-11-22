import { Context, Effect, Layer, Option, Schedule } from "effect";
import { HttpClient } from "effect/http";
import { GdeltError } from "../errors";
import { parseLastUpdate, parseSlice, sliceUrl, type GdeltRow } from "./parse";

const LAST_UPDATE = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";

export class Gdelt extends Context.Service<Gdelt, {
  /** Timestamp of the newest published slice. */
  readonly latestSlice: Effect.Effect<Date, GdeltError>;
  /** `None` when the slice isn't published yet (404): don't record it, try again later. */
  slice(ts: Date): Effect.Effect<Option.Option<ReadonlyArray<GdeltRow>>, GdeltError>;
}>()("news/gdelt/Gdelt") {
  static readonly layer = Layer.effect(
    Gdelt,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 3 }),
      );
      const fail = (message: string) => (cause: unknown) => new GdeltError({ message, cause });

      const latestSlice = http.get(LAST_UPDATE).pipe(
        Effect.flatMap((res) => (res.status === 200 ? res.text : Effect.fail(new Error(`HTTP ${res.status}`)))),
        Effect.flatMap((text) => Effect.try(() => parseLastUpdate(text))),
        Effect.mapError(fail("lastupdate.txt")),
        Effect.withSpan("Gdelt.latestSlice"),
      );

      const slice = Effect.fn("Gdelt.slice")(function* (ts: Date) {
        const res = yield* http.get(sliceUrl(ts)).pipe(
          Effect.timeout("60 seconds"),
          Effect.mapError(fail(sliceUrl(ts))),
        );
        if (res.status === 404) return Option.none<ReadonlyArray<GdeltRow>>();
        if (res.status !== 200) return yield* new GdeltError({ message: `${sliceUrl(ts)}: HTTP ${res.status}` });
        const zipped = yield* res.arrayBuffer.pipe(Effect.mapError(fail("reading slice body")));
        const rows = yield* Effect.try({
          try: () => parseSlice(new Uint8Array(zipped)),
          catch: fail("unzip/parse slice"),
        });
        return Option.some(rows);
      });

      return Gdelt.of({ latestSlice, slice });
    }),
  );
}
