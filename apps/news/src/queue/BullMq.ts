import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";
import { Config, Context, Effect, Layer, type Scope } from "effect";
import IORedis from "ioredis";

/** BullMQ's promise API as scoped Effect resources: everything is closed when the scope ends. */
export class BullMq extends Context.Service<BullMq, {
  queue<D>(name: string): Effect.Effect<Queue<D>, never, Scope.Scope>;
  worker<D>(name: string, processor: Processor<D>, opts?: Omit<WorkerOptions, "connection">): Effect.Effect<Worker<D>, never, Scope.Scope>;
}>()("news/queue/BullMq") {
  static readonly layer = Layer.effect(
    BullMq,
    Effect.gen(function* () {
      const url = yield* Config.String("REDIS_URL").pipe(Config.withDefault("redis://localhost:6380"));
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => new IORedis(url, { maxRetriesPerRequest: null })),
        (c) => Effect.promise(() => c.quit()).pipe(Effect.ignore),
      );

      const queue = <D>(name: string) =>
        Effect.acquireRelease(
          Effect.sync(() => new Queue<D>(name, { connection })),
          (q) => Effect.promise(() => q.close()),
        );

      const worker = <D>(name: string, processor: Processor<D>, opts?: Omit<WorkerOptions, "connection">) =>
        Effect.acquireRelease(
          Effect.sync(() => new Worker<D>(name, processor, { ...opts, connection })),
          (w) => Effect.promise(() => w.close()), // waits for in-flight jobs
        );

      return BullMq.of({ queue, worker });
    }),
  );
}
