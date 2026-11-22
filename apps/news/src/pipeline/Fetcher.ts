import { Context, Duration, Effect, Layer } from "effect";
import { HttpClientRequest } from "effect/http";
import { CircuitBreaker } from "effect/persistence";
import { DomainCooldown, ExtractError, FetchError } from "../errors";
import { extract } from "../extract/extract";
import { parseRetryAfter, PoliteClient, type PoliteError } from "../http/PoliteClient";
import { Articles } from "../repos/Articles";
import type { UrlJob } from "../repos/Urls";

const MAX_BYTES = 2_000_000;
const UA = "Mozilla/5.0 (compatible; orbit-news/0.1)";
const HALF_OPEN_WAIT_MS = 5_000;

export type Outcome = "ok" | "short" | "non_english";

/** Classify what the polite client can fail with. Open circuit => park the job, don't count an attempt. */
const fromClient = (url: string) => (e: PoliteError | { readonly _tag: string }): FetchError | DomainCooldown => {
  if (e instanceof CircuitBreaker.CircuitBreakerError) {
    const ms = e.reason._tag === "CircuitOpen" ? Duration.toMillis(e.reason.retryAfter) : HALF_OPEN_WAIT_MS;
    return new DomainCooldown({ url, retryAfterMs: ms });
  }
  return new FetchError({ url, message: `network: ${e._tag}`, retryable: true });
};

export class Fetcher extends Context.Service<Fetcher, {
  /** Download, extract and store one page. */
  fetch(job: UrlJob): Effect.Effect<Outcome, FetchError | DomainCooldown | ExtractError>;
}>()("news/pipeline/Fetcher") {
  static readonly layer = Layer.effect(
    Fetcher,
    Effect.gen(function* () {
      const http = yield* PoliteClient;
      const articles = yield* Articles;

      const fetch = Effect.fn("Fetcher.fetch")(function* (job: UrlJob) {
        const fail = (message: string, retryable: boolean, retryAfterMs?: number) =>
          new FetchError({ url: job.url, message, retryable, retryAfterMs });

        const res = yield* http.execute(HttpClientRequest.get(job.url).pipe(HttpClientRequest.setHeaders({ "user-agent": UA, accept: "text/html" }))).pipe(
          Effect.mapError(fromClient(job.url)),
        );
        if (res.status === 429 || res.status >= 500) {
          const wait = parseRetryAfter(res.headers["retry-after"]);
          return yield* fail(`http ${res.status}`, true, wait && Duration.toMillis(wait));
        }
        if (res.status < 200 || res.status >= 300) return yield* fail(`http ${res.status}`, false);
        if (!/html/i.test(res.headers["content-type"] ?? "")) return yield* fail("not html", false);
        if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) return yield* fail("too large", false);

        // The client's timeout stops at the headers; a stalled body needs its own deadline.
        const bytes = yield* res.arrayBuffer.pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(() => fail("network: body", true)),
        );
        const x = yield* extract(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, MAX_BYTES)));
        yield* articles.save(job, x);
        return (x.rejectReason ?? "ok") as Outcome;
      });

      return Fetcher.of({ fetch });
    }),
  );
}
