import { expect, test } from "bun:test";
import { Duration, Effect, Exit, Layer, Cause } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CircuitBreaker } from "effect/persistence";
import { DomainCooldown, FetchError } from "../src/errors";
import type { Extracted } from "../src/extract/extract";
import { PoliteClient } from "../src/http/PoliteClient";
import { Fetcher } from "../src/pipeline/Fetcher";
import { Articles } from "../src/repos/Articles";
import type { UrlJob } from "../src/repos/Urls";
import { ATTEMPTS, decide, jobId, retryDelayMs } from "../src/queue/FetchQueue";

const job: UrlJob = { url: "https://a.test/story", domain: "a.test", seenAt: new Date("2025-11-19T00:00:00Z") };
const article = `<html lang="en"><head><meta property="og:title" content="Senate votes"></head><body>${"<p>A reasonably long paragraph of article text for the extractor.</p>".repeat(20)}</body></html>`;

const fetchWith = (respond: () => Response | Effect.Effect<never, any>) => {
  const saved: Extracted[] = [];
  const client = HttpClient.make((req) => {
    const r = respond();
    return r instanceof Response ? Effect.succeed(HttpClientResponse.fromWeb(req, r)) : r;
  });
  const layer = Fetcher.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(PoliteClient, client as never),
    Layer.succeed(Articles, Articles.of({ save: (_j, x) => Effect.sync(() => void saved.push(x)) })),
  )));
  const exit = Effect.runPromiseExit(Effect.gen(function* () { return yield* (yield* Fetcher).fetch(job); }).pipe(Effect.provide(layer)));
  return { exit, saved };
};
const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);

test("200 html is extracted and saved", async () => {
  const { exit, saved } = fetchWith(() => new Response(article, { headers: { "content-type": "text/html" } }));
  expect(await exit).toEqual(Exit.succeed("ok"));
  expect(saved).toHaveLength(1);
});

test("404 is a permanent failure", async () => {
  const err = failure(await fetchWith(() => new Response("", { status: 404 })).exit) as FetchError;
  expect(err).toBeInstanceOf(FetchError);
  expect(err.retryable).toBe(false);
});

test("429 is retryable and carries the server's Retry-After", async () => {
  const err = failure(await fetchWith(() => new Response("", { status: 429, headers: { "retry-after": "120" } })).exit) as FetchError;
  expect(err).toMatchObject({ retryable: true, retryAfterMs: 120_000 });
});

test("an open circuit becomes a DomainCooldown, not a failed attempt", async () => {
  const open = Effect.fail(new CircuitBreaker.CircuitBreakerError({ reason: new CircuitBreaker.CircuitOpen({ key: "a.test", retryAfter: Duration.seconds(30) }) }));
  const err = failure(await fetchWith(() => open).exit);
  expect(err).toBeInstanceOf(DomainCooldown);
  expect((err as DomainCooldown).retryAfterMs).toBe(30_000);
});

test("decide: what the worker does with each outcome", () => {
  const fail = (e: unknown) => Exit.fail(e) as Exit.Exit<never, FetchError | DomainCooldown>;
  const retryable = new FetchError({ url: "u", message: "http 503", retryable: true });
  expect(decide(Exit.succeed("ok"), 0, 0)).toEqual({ _tag: "done" });
  expect(decide(fail(new FetchError({ url: "u", message: "http 403", retryable: false })), 0, 0)).toMatchObject({ _tag: "fail", unrecoverable: true });
  expect(decide(fail(retryable), 0, 0)).toMatchObject({ _tag: "fail", unrecoverable: false, final: false });
  expect(decide(fail(retryable), ATTEMPTS - 1, 0)).toMatchObject({ final: true }); // last attempt -> ledger marks failed
  expect(decide(fail(new DomainCooldown({ url: "u", retryAfterMs: 60_000 })), 0, 0, 0.5)).toEqual({ _tag: "park", ms: 60_000 });
  expect(decide(fail(new DomainCooldown({ url: "u", retryAfterMs: 60_000 })), 0, 24)).toMatchObject({ _tag: "fail", final: false }); // parked too often
  expect(decide(Exit.die(new Error("boom")), 0, 0)).toMatchObject({ _tag: "fail", unrecoverable: false });
});

test("retryDelayMs: exponential from 5 min, honours Retry-After, capped at 1 h, jittered ±20%", () => {
  expect(retryDelayMs(1, undefined, 0.5)).toBe(300_000);
  expect(retryDelayMs(2, undefined, 0.5)).toBe(600_000);
  expect(retryDelayMs(1, 1_800_000, 0.5)).toBe(1_800_000);
  expect(retryDelayMs(9, undefined, 0.5)).toBe(3_600_000);
  expect(retryDelayMs(1, undefined, 0)).toBe(240_000);
  expect(retryDelayMs(1, undefined, 1)).toBe(360_000);
});

test("jobId is stable and never a plain integer", () => {
  expect(jobId("https://a.test/x")).toBe(jobId("https://a.test/x"));
  expect(jobId("https://a.test/x")).toMatch(/^u_[0-9a-f]{40}$/);
});
