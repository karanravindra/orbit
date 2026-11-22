import { Config, Context, Effect, Layer, type Scope } from "effect";
import { paramsConfig } from "../cluster/params";
import { Cluster } from "../pipeline/Cluster";
import { Embed } from "../pipeline/Embed";
import { Ingest } from "../pipeline/Ingest";
import { Reports } from "../pipeline/Reports";
import { Summaries } from "../pipeline/Summaries";
import { Topics } from "../pipeline/Topics";
import { Summarizer } from "../summaries/Summarizer";
import { BullMq } from "./BullMq";

const MIN = 60_000;

/**
 * The recurring pipeline stages, each a BullMQ job scheduler plus a single-concurrency worker:
 *   ingest  every 15 min  GDELT slices -> ledger -> fetch queue
 *   embed   every 30 s    new article texts -> Ollama -> vectors
 *   cluster every 2 min   new vectors -> stories
 *   topics  every 2 min   unclassified stories -> section (small local LLM)
 *   reports every 1 min   stories whose size changed -> independent-report count (text overlap, no model)
 *   summary every 20 s    requested stories first, then the most visible ones lacking a summary (small local LLM, kept warm)
 * Every stage is idempotent and reads its backlog from Postgres, so a missed or failed tick just runs again later.
 */
export class Schedulers extends Context.Service<Schedulers, {
  /** Register the schedules and run their workers until the scope closes. */
  start(opts: { readonly ingestHours: number }): Effect.Effect<void, never, Scope.Scope>;
}>()("news/queue/Schedulers") {
  static readonly layer = Layer.effect(
    Schedulers,
    Effect.gen(function* () {
      const bull = yield* BullMq;
      const ingest = yield* Ingest;
      const embed = yield* Embed;
      const cluster = yield* Cluster;
      const topics = yield* Topics;
      const reports = yield* Reports;
      const summaries = yield* Summaries;
      const summarizer = yield* Summarizer;

      /** Upsert a repeating job (idempotent across restarts) and process it one at a time. */
      const every = <D extends object>(name: string, ms: number, data: D, run: (d: D) => Effect.Effect<unknown, unknown>) =>
        Effect.gen(function* () {
          const queue = yield* bull.queue<any>(name);
          yield* Effect.promise(() =>
            queue.upsertJobScheduler(name, { every: ms }, { name, data, opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } } }),
          );
          yield* bull.worker<D>(name, (job) => Effect.runPromise(run(job.data)), { concurrency: 1 });
        });

      const start = Effect.fn("Schedulers.start")(function* (opts: { readonly ingestHours: number }) {
        const params = yield* Effect.orDie(paramsConfig);
        yield* every("news-ingest", 15 * MIN, { hours: opts.ingestHours }, (d) => ingest.run(d.hours));
        yield* every("news-embed", 30_000, {}, () => embed.run());
        yield* every("news-cluster", 2 * MIN, {}, () => cluster.run(params));
        yield* every("news-topics", 2 * MIN, {}, () => topics.run());
        yield* every("news-reports", MIN, {}, () => reports.run());
        // Opt-in: the writer spends GPU time, so it only runs when SUMMARIES=on.
        if (!(yield* Effect.orDie(Config.Boolean("SUMMARIES").pipe(Config.withDefault(false))))) return yield* Effect.log("summary writer is off (set SUMMARIES=on to enable)");
        // Load the model once now: Ollama needs seconds to start it, which is why summaries are written ahead of time, never on a request.
        yield* Effect.forkScoped(summarizer.warm);
        yield* every("news-summaries", 20_000, {}, () => summaries.run());
      });

      return Schedulers.of({ start });
    }),
  );
}
