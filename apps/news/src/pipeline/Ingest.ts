import { Context, Effect, Layer, Option } from "effect";
import type { GdeltError } from "../errors";
import { Gdelt } from "../gdelt/Gdelt";
import { SLICE_MS, floorSlice } from "../gdelt/parse";
import { FetchQueue } from "../queue/FetchQueue";
import { Urls } from "../repos/Urls";

export class Ingest extends Context.Service<Ingest, {
  /** Pull every unseen GDELT slice from the last `hours` hours into the ledger and enqueue the new URLs. */
  run(hours: number): Effect.Effect<number, GdeltError>;
}>()("news/pipeline/Ingest") {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const gdelt = yield* Gdelt;
      const urls = yield* Urls;
      const fetchQueue = yield* FetchQueue;

      const run = Effect.fn("Ingest.run")(function* (hours: number) {
        const latest = yield* gdelt.latestSlice;
        const since = new Date(latest.getTime() - hours * 3_600_000);
        const have = yield* urls.ingestedSlices(since);

        let total = 0;
        for (let t = floorSlice(since).getTime(); t <= latest.getTime(); t += SLICE_MS) {
          if (have.has(t)) continue;
          const ts = new Date(t);
          const rows = yield* gdelt.slice(ts);
          if (Option.isNone(rows)) {
            yield* Effect.logWarning(`${ts.toISOString()} not published yet, skipping`);
            continue;
          }
          const fresh = yield* urls.ingestSlice(ts, rows.value);
          // Insert-then-enqueue is a dual write: a crash in between leaves rows pending. `requeueUnfinished`
          // (run at worker start / `enqueue`) closes that gap.
          yield* fetchQueue.enqueue(fresh);
          total += fresh.length;
          yield* Effect.log(`${ts.toISOString()} ${rows.value.length} rows, ${fresh.length} new urls queued`);
        }
        return total;
      });

      return Ingest.of({ run });
    }),
  );
}
