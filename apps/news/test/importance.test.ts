import { expect, test } from "bun:test";
import { importance } from "../src/repos/importance";

const now = Date.parse("2026-11-22T12:00:00Z");
const h = (n: number) => new Date(now - n * 3_600_000);
const base = { outlets: 30, reports: 12, articles: 40, recent: 4, firstSeen: h(30), lastSeen: h(1) };

test("importance: wider coverage ranks higher", () => {
  expect(importance({ ...base, outlets: 60 }, now).score).toBeGreaterThan(importance(base, now).score);
});
test("importance: an idle story decays against a live one", () => {
  expect(importance({ ...base, lastSeen: h(36) }, now).score).toBeLessThan(importance(base, now).score);
});
test("importance: a young, fast-growing story outranks a bigger but stale one", () => {
  const breaking = { outlets: 20, reports: 8, articles: 30, recent: 25, firstSeen: h(3), lastSeen: h(0.2) };
  const stale = { outlets: 40, reports: 15, articles: 60, recent: 0, firstSeen: h(40), lastSeen: h(30) };
  expect(importance(breaking, now).score).toBeGreaterThan(importance(stale, now).score);
});
test("importance: breaking needs youth, breadth, recency and momentum", () => {
  const b = { outlets: 20, reports: 8, articles: 30, recent: 25, firstSeen: h(3), lastSeen: h(0.2) };
  expect(importance(b, now).breaking).toBe(true);
  expect(importance({ ...b, firstSeen: h(20) }, now).breaking).toBe(false);
  expect(importance({ ...b, outlets: 3 }, now).breaking).toBe(false);
  expect(importance({ ...b, recent: 2 }, now).breaking).toBe(false);
  expect(importance({ ...b, lastSeen: h(5) }, now).breaking).toBe(false);
});
test("importance: a wire story carried by many outlets ranks below one with many independent reports", () => {
  const wire = { ...base, outlets: 80, reports: 4 };
  const reported = { ...base, outlets: 30, reports: 25 };
  expect(importance(reported, now).score).toBeGreaterThan(importance(wire, now).score);
});
