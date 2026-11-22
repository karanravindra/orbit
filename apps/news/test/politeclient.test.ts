import { expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { CircuitBreaker, RateLimiter } from "effect/persistence";
import { TestClock } from "effect/testing";
import { make, parseRetryAfter } from "../src/http/PoliteClient";

const Env = Layer.mergeAll(TestClock.layer(), CircuitBreaker.layerStoreMemory(), RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)));

/** Stub origin: every request gets `status`/`headers`; counts hits. */
const origin = (status: number, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const hits = yield* Ref.make(0);
    const base = HttpClient.make((req) => Ref.update(hits, (n) => n + 1).pipe(Effect.as(HttpClientResponse.fromWeb(req, new Response("x", { status, headers })))));
    return { client: yield* make(base), hits };
  });

/** Run one request under virtual time; returns what happened and how many virtual seconds it waited. */
const call = (client: Effect.Success<ReturnType<typeof origin>>["client"], url: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(client.execute(HttpClientRequest.get(url))));
    let waited = 0;
    for (let i = 0; i < 100; i++) {
      yield* Effect.yieldNow;
      if (fiber.pollUnsafe()) break;
      yield* TestClock.adjust("1 second");
      waited++;
    }
    const exit = yield* Fiber.join(fiber);
    if (Exit.isSuccess(exit)) return { status: exit.value.status, waited };
    const err = Cause.squash(exit.cause) as { reason?: { _tag: string; retryAfter?: Duration.Duration } };
    return { error: err.reason?._tag, retryAfterMs: err.reason?.retryAfter && Duration.toMillis(err.reason.retryAfter), waited };
  });

const run = <A>(e: Effect.Effect<A, never, any>) => Effect.runPromise(e.pipe(Effect.scoped, Effect.provide(Env)) as Effect.Effect<A>);

test("spaces requests to one domain (1/s) but not across domains", () =>
  run(Effect.gen(function* () {
    const { client } = yield* origin(200);
    expect((yield* call(client, "http://a.test/1")).waited).toBe(0);
    expect((yield* call(client, "http://a.test/2")).waited).toBe(1);
    expect((yield* call(client, "http://b.test/1")).waited).toBe(0);
  })));

test("429 comes back immediately; two in a row open the domain circuit for the capped Retry-After", () =>
  run(Effect.gen(function* () {
    const { client, hits } = yield* origin(429, { "retry-after": "7200" }); // asks for 2 h, we cap at 1 h
    expect(yield* call(client, "http://a.test/1")).toMatchObject({ status: 429 });
    expect(yield* call(client, "http://a.test/2")).toMatchObject({ status: 429 });
    const parked = yield* call(client, "http://a.test/3");
    expect(parked).toMatchObject({ error: "CircuitOpen", retryAfterMs: 3_600_000, waited: 0 });
    expect(yield* Ref.get(hits)).toBe(2); // the third call never reached the origin
    expect(yield* call(client, "http://b.test/1")).toMatchObject({ status: 429 }); // other domains unaffected
  })));

test("a healthy origin never trips the circuit", () =>
  run(Effect.gen(function* () {
    const { client } = yield* origin(200);
    for (let i = 0; i < 5; i++) expect((yield* call(client, `http://a.test/${i}`)).status).toBe(200);
  })));

test("parseRetryAfter: seconds, HTTP dates, cap, garbage", () => {
  const ms = (v: string | undefined) => parseRetryAfter(v, Date.parse("2025-01-01T00:00:00Z"))?.pipe(Duration.toMillis);
  expect(ms("120")).toBe(120_000);
  expect(ms("999999")).toBe(3_600_000);
  expect(ms("Wed, 01 Jan 2025 00:01:00 GMT")).toBe(60_000);
  expect(ms("Tue, 31 Dec 2024 00:00:00 GMT")).toBe(0);
  expect(ms("soon")).toBeUndefined();
  expect(ms(undefined)).toBeUndefined();
});
