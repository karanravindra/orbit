/** An HttpClient that is polite to origins: per-domain spacing, domain cooldown after 429/5xx, bounded waits. */
import { Context, Duration, Effect, Exit, Layer, Schedule } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";
import { CircuitBreaker, RateLimiter } from "effect/persistence";

export type PoliteError = HttpClientError.HttpClientError | RateLimiter.RateLimiterError | CircuitBreaker.CircuitBreakerError;

export const MAX_COOLDOWN = Duration.hours(1);
const DEFAULT_COOLDOWN = Duration.seconds(30);

/** `Retry-After` is either delta-seconds or an HTTP date. Capped so a hostile header can't park us for a day. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): Duration.Duration | undefined {
  if (!value) return undefined;
  const secs = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(secs)) return undefined;
  return Duration.min(Duration.seconds(Math.max(secs, 0)), MAX_COOLDOWN);
}

const hostname = (r: { readonly url: string }) => new URL(r.url).hostname.replace(/^www\./, "");

/**
 * Stack, inner → outer:
 *  timeout            15 s per attempt (headers only; callers bound the body read)
 *  withRateLimiter    1 req/s per domain. Response inspection is OFF: with it on, Retry-After is honoured
 *                     in-process with no cap (a `Retry-After: 3600` parks the worker for hours).
 *  retryTransient     network errors only, 2 quick jittered retries. 429/5xx come back as responses.
 *  withCircuitBreaker per domain; 429/503 count as failures and carry the (capped) Retry-After as the cooldown.
 *                     Open circuit => fast `CircuitBreakerError` with `retryAfter`, so the caller parks the job.
 */
export const make = (base: HttpClient.HttpClient.With<HttpClientError.HttpClientError>) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter.RateLimiter;
    const breaker = yield* CircuitBreaker.make({
      tripPolicy: CircuitBreaker.consecutive(2),
      openDuration: Schedule.exponential(DEFAULT_COOLDOWN),
      maxOpenDuration: MAX_COOLDOWN,
    });
    return base.pipe(
      HttpClient.timeout("15 seconds"),
      HttpClient.withRateLimiter({ limiter, key: hostname, limit: 1, window: "1 second", algorithm: "token-bucket", times: 0, disableResponseInspection: true }),
      HttpClient.retryTransient({ retryOn: "errors-only", times: 2, schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered) }),
      HttpClient.withCircuitBreaker({
        breaker,
        key: hostname,
        classify: (exit) =>
          Exit.isSuccess(exit) && (exit.value.status === 429 || exit.value.status === 503)
            ? CircuitBreaker.failure({ retryAfter: parseRetryAfter(exit.value.headers["retry-after"]) ?? DEFAULT_COOLDOWN })
            : HttpClient.circuitBreakerClassifier(exit),
      }),
    ) as HttpClient.HttpClient.With<PoliteError>;
  });

export class PoliteClient extends Context.Service<PoliteClient, HttpClient.HttpClient.With<PoliteError>>()("news/http/PoliteClient") {
  /** Needs a base `HttpClient`, a `RateLimiter` and a `CircuitBreakerStore`. */
  static readonly layer = Layer.effect(
    PoliteClient,
    Effect.gen(function* () {
      return yield* make(yield* HttpClient.HttpClient);
    }),
  );
}
