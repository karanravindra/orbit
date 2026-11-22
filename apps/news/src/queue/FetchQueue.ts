import { createHash } from "node:crypto";
import { DelayedError, UnrecoverableError, type Job, type JobsOptions } from "bullmq";
import { Array as Arr, Cause, Context, Effect, Exit, Layer, type Scope } from "effect";
import { DomainCooldown, ExtractError, FetchError } from "../errors";
import { Fetcher } from "../pipeline/Fetcher";
import { Urls, urlKey, type UrlJob } from "../repos/Urls";
import { BullMq } from "./BullMq";

export const QUEUE = "news-fetch";
export const ATTEMPTS = 5;
const MAX_PARKS = 24; // a domain that stays cooled down this many times in a row costs an attempt instead
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const CHUNK = 1000;

interface Data {
  readonly url: string;
  readonly domain: string;
  readonly seenAt: string;
  readonly parks?: number;
}

/** Prefixed because BullMQ rejects job ids that are plain integers (and ids containing ":"). */
export const jobId = (url: string) => `u_${createHash("sha1").update(url).digest("hex")}`;

const shuffled = <A>(xs: ReadonlyArray<A>): A[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const jitter = (ms: number, rand: number) => Math.round(ms * (0.8 + 0.4 * rand));

/** Tier-2 retry delay: exponential from 5 min, never shorter than the server asked, capped at 1 h, jittered. */
export const retryDelayMs = (attemptsMade: number, retryAfterMs: number | undefined, rand: number = Math.random()): number =>
  jitter(Math.min(Math.max(BASE_BACKOFF_MS * 2 ** (attemptsMade - 1), retryAfterMs ?? 0), MAX_BACKOFF_MS), rand);

export type Action =
  | { readonly _tag: "done" }
  | { readonly _tag: "park"; readonly ms: number }
  | { readonly _tag: "fail"; readonly message: string; readonly unrecoverable: boolean; readonly final: boolean; readonly cause: unknown };

/** Pure: what to do with a finished job, given how it ended. */
export function decide(exit: Exit.Exit<unknown, FetchError | DomainCooldown | ExtractError>, attemptsMade: number, parks: number, rand: number = Math.random()): Action {
  if (Exit.isSuccess(exit)) return { _tag: "done" };
  const err = Cause.squash(exit.cause);
  const final = attemptsMade + 1 >= ATTEMPTS;
  if (err instanceof DomainCooldown && parks < MAX_PARKS) return { _tag: "park", ms: jitter(err.retryAfterMs, rand) };
  if (err instanceof FetchError && !err.retryable) return { _tag: "fail", message: err.message, unrecoverable: true, final: true, cause: err };
  if (err instanceof ExtractError) return { _tag: "fail", message: err.message, unrecoverable: true, final: true, cause: err };
  const message = err instanceof FetchError ? err.message : err instanceof DomainCooldown ? "domain cooldown" : `defect: ${Cause.pretty(exit.cause).split("\n")[0]}`;
  return { _tag: "fail", message, unrecoverable: false, final, cause: err };
}

export class FetchQueue extends Context.Service<FetchQueue, {
  /** Add jobs (deduped by url). Returns how many were submitted. */
  enqueue(jobs: ReadonlyArray<UrlJob>): Effect.Effect<number>;
  /** Re-enqueue everything the ledger still lists as unfinished. Idempotent; the safety net for crashes and Redis loss. */
  requeueUnfinished: Effect.Effect<number>;
  /** Run the fetch worker until the scope closes. */
  start(concurrency: number): Effect.Effect<void, never, Scope.Scope>;
  counts: Effect.Effect<Record<string, number>>;
}>()("news/queue/FetchQueue") {
  static readonly layer = Layer.effect(
    FetchQueue,
    Effect.gen(function* () {
      const bull = yield* BullMq;
      const fetcher = yield* Fetcher;
      const urls = yield* Urls;
      const queue = yield* bull.queue<Data>(QUEUE);

      const opts: JobsOptions = {
        attempts: ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 7 * 86_400 },
      };

      const enqueue = Effect.fn("FetchQueue.enqueue")(function* (jobs: ReadonlyArray<UrlJob>) {
        // Shuffle so a hot domain's URLs aren't adjacent: workers waiting on its rate limit would starve the rest.
        for (const chunk of Arr.chunksOf(shuffled(jobs), CHUNK)) {
          yield* Effect.promise(() =>
            queue.addBulk(chunk.map((j) => ({ name: "fetch", data: { url: j.url, domain: j.domain, seenAt: j.seenAt.toISOString() }, opts: { ...opts, jobId: jobId(j.url) } }))),
          );
        }
        return jobs.length;
      });

      const requeueUnfinished = Effect.gen(function* () {
        let after = "";
        let total = 0;
        while (true) {
          const page = yield* urls.unfinished(after, CHUNK);
          if (page.length === 0) return total;
          total += yield* enqueue(page);
          after = urlKey(page[page.length - 1]!.url);
        }
      }).pipe(Effect.withSpan("FetchQueue.requeueUnfinished"));

      const process = (job: Job<Data>) =>
        Effect.gen(function* () {
          const jobInfo: UrlJob = { url: job.data.url, domain: job.data.domain, seenAt: new Date(job.data.seenAt) };
          const exit = yield* Effect.promise(() => Effect.runPromiseExit(fetcher.fetch(jobInfo)));
          const action = decide(exit, job.attemptsMade, job.data.parks ?? 0);
          // Ledger writes happen here (not in event handlers) so they land before the job leaves the queue.
          if (action._tag === "fail") yield* action.unrecoverable || action.final ? urls.markFailed(job.data.url, action.message) : urls.markRetry(job.data.url, action.message);
          return action;
        }).pipe(Effect.withSpan("FetchQueue.process", { attributes: { url: job.data.url } }));

      const start = (concurrency: number) =>
        bull.worker<Data>(
          QUEUE,
          async (job, token) => {
            const action = await Effect.runPromise(process(job));
            if (action._tag === "done") return "ok";
            if (action._tag === "park") {
              // Doesn't consume an attempt; the counter in job data bounds it so a dead origin can't loop forever.
              await job.updateData({ ...job.data, parks: (job.data.parks ?? 0) + 1 });
              await job.moveToDelayed(Date.now() + action.ms, token);
              throw new DelayedError();
            }
            if (action.unrecoverable) throw new UnrecoverableError(action.message);
            throw action.cause instanceof Error ? action.cause : new Error(action.message);
          },
          {
            concurrency,
            settings: {
              backoffStrategy: (attemptsMade, _type, err) => retryDelayMs(attemptsMade, err instanceof FetchError ? err.retryAfterMs : undefined),
            },
          },
        ).pipe(Effect.asVoid);

      const counts = Effect.promise(() => queue.getJobCounts()) as Effect.Effect<Record<string, number>>;

      return FetchQueue.of({ enqueue, requeueUnfinished, start, counts });
    }),
  );
}
