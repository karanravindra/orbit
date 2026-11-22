import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { toPg } from "../src/cluster/vec";
import { blindspot, sideShares, type BiasCounts } from "../src/outlets/bias";
import { normaliseDomain, parseOutlets, splitLine } from "../src/outlets/csv";
import { Feed } from "../src/repos/Feed";
import { Outlets } from "../src/repos/Outlets";
import { dbUp, rolledBack } from "./helpers";

const counts = (c: Partial<BiasCounts>): BiasCounts => ({ left: 0, leanLeft: 0, center: 0, leanRight: 0, right: 0, unrated: 0, ...c });

test("bias: side shares and blindspot rules", () => {
  expect(sideShares(counts({ left: 1, leanLeft: 1, center: 1, right: 1 }))).toEqual({ left: 0.5, center: 0.25, right: 0.25 });
  expect(sideShares(counts({ unrated: 9 }))).toEqual({ left: 0, center: 0, right: 0 });
  expect(blindspot(counts({ left: 3, leanLeft: 2, center: 1 }))).toBe("right"); // nobody on the right covered it
  expect(blindspot(counts({ right: 4, leanRight: 1 }))).toBe("left");
  expect(blindspot(counts({ left: 2, right: 2, center: 1 }))).toBeNull(); // both sides covered it
  expect(blindspot(counts({ left: 3 }))).toBeNull(); // too few rated outlets to say
  expect(blindspot(counts({ left: 3, unrated: 50 }))).toBeNull(); // unrated outlets don't count as evidence
});

test("csv: quotes, normalisation, bad rows reported", () => {
  expect(splitLine('a.com,"Foo, Inc ""X""",left')).toEqual(["a.com", 'Foo, Inc "X"', "left"]);
  expect(normaliseDomain("https://WWW.Example.com/path")).toBe("example.com");
  const { rows, errors } = parseOutlets(
    "domain,name,bias,factuality,country\nwww.a.com,A,Lean-Left,HIGH,US\nb.com,B,sideways,,\nnodot,C,left,,\na.com,A2,center,,GB\n",
  );
  expect(rows).toEqual([{ domain: "a.com", name: "A2", bias: "center", factuality: null, country: "GB" }]); // later duplicate wins
  expect(errors.length).toBe(2);
  expect(parseOutlets("name,bias\nx,left").errors[0]).toMatch(/header/);
});

const T = new Date("2030-02-01T00:00:00Z");
const axis = (i: number, j = -1) => {
  const v = new Float32Array(768);
  v[i] = 1;
  if (j >= 0) v[j] = 0.3;
  return toPg(v);
};

test.skipIf(!dbUp)("Feed: bias spread per story, suffix rating match, blindspot, detail", async () => {
  const out = await rolledBack(
    Feed.layer.pipe(Layer.provideMerge(Outlets.layer)),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const feed = yield* Feed;
      const outlets = yield* Outlets;
      yield* sql`delete from embeddings`;
      yield* sql`delete from stories`;
      yield* outlets.replace("test", [
        { domain: "l1.test", name: "Left One", bias: "left", factuality: "high", country: null },
        { domain: "l2.test", name: "Left Two", bias: "lean-left", factuality: null, country: null },
        { domain: "l3.test", name: "Left Three", bias: "left", factuality: null, country: null },
        { domain: "c1.test", name: "Centre One", bias: "center", factuality: null, country: null },
        { domain: "r1.test", name: "Right One", bias: "right", factuality: "low", country: null },
      ]);
      const [{ id }] = (yield* sql<{ id: number }>`insert into stories (centroid, n, first_seen, last_seen, mean_version) values (${axis(0)}::vector, 5, ${T}, ${T}, 1) returning id`) as [{ id: number }];

      let k = 0;
      const add = (storyId: number, domain: string, title: string, nearCentroid: boolean, lede = "lede", body: string | null = null) =>
        Effect.gen(function* () {
          const url = `https://${domain}/${k++}`;
          yield* sql`insert into urls (url, domain, seen_at) values (${url}, ${domain}, ${T})`;
          yield* sql`insert into articles (url, domain, title, lede, body, seen_at) values (${url}, ${domain}, ${title}, ${lede}, ${body}, ${T})`;
          const [r] = yield* sql<{ embedKey: string }>`select embed_key from articles where url = ${url}`;
          const v = nearCentroid ? axis(0, 1 + k) : axis(2, 3 + k);
          yield* sql`insert into embeddings (embed_key, vec, cvec) values (${r!.embedKey}, ${v}::vector, ${v}::vector)`;
          yield* sql`insert into story_texts (embed_key, story_id, sim) values (${r!.embedKey}, ${storyId}, 0.9)`;
        });
      // l2 is matched by suffix (news.l2.test); two articles from l1 still count as one outlet; "u.test" has no rating
      yield* add(id, "l1.test", "Central headline", true);
      yield* add(id, "l1.test", "Off-centre take", false);
      yield* add(id, "news.l2.test", "Second", false);
      yield* add(id, "l3.test", "Third", false);
      yield* add(id, "c1.test", "Fourth", false);
      const paywall = "You have reached your maximum number of saved items.";
      yield* add(id, "u.test", "Fifth", false, paywall, `${paywall}\n\nA real first paragraph that is long enough to count as one.`); // lede is a paywall banner
      // two unrated stations of one network: one outlet, rating borrowed from c1.test (centre)
      yield* outlets.setFamilies([{ pattern: "^k[a-z]{3}\\.test$", family: "Stations", inheritFrom: "c1.test", unratedOnly: true, priority: 1 }]);
      yield* add(id, "kaaa.test", "Station A", false);
      yield* add(id, "kbbb.test", "Station B", false);

      yield* sql`update articles set image_url = 'https://img.test/logo.png' where domain = 'l1.test'`; // logos never win
      yield* sql`update articles set image_url = 'https://img.test/story.jpg' where domain in ('l3.test', 'c1.test')`;
      yield* sql`update articles set image_url = 'https://img.test/other.jpg' where domain = 'u.test'`;
      const listed = yield* feed.list({ limit: 10, minOutlets: 3, sort: "coverage", hours: 24 * 365 * 10 });
      const strict = yield* feed.list({ limit: 10, minOutlets: 10, sort: "coverage", hours: 24 * 365 * 10 });
      const blind = yield* feed.list({ limit: 10, minOutlets: 3, sort: "recent", hours: 24 * 365 * 10, blindspotOnly: true });
      const detail = yield* feed.get(Number(id));
      const missing = yield* feed.get(-1);
      const cov = yield* outlets.coverage;
      const fresh = yield* feed.list({ limit: 10, minOutlets: 3, sort: "coverage", hours: 24 });
      const unsorted = yield* feed.topics({ minOutlets: 3, hours: 24 * 365 * 10 });
      yield* sql`update stories set topic = 'politics' where id = ${id}`;
      const sorted = yield* feed.topics({ minOutlets: 3, hours: 24 * 365 * 10 });
      const inTopic = yield* feed.list({ limit: 10, minOutlets: 3, sort: "coverage", hours: 24 * 365 * 10, topic: "politics" });
      const otherTopic = yield* feed.list({ limit: 10, minOutlets: 3, sort: "coverage", hours: 24 * 365 * 10, topic: "sports" });
      yield* sql`update stories set last_seen = '2000-01-01'`;
      const stale = yield* feed.list({ limit: 10, minOutlets: 3, sort: "coverage", hours: 24 });
      return { id: Number(id), unsorted, sorted, inTopic, otherTopic, listed, strict, blind, detail, missing, cov, fresh, stale };
    }).pipe(Effect.orDie),
  );

  const s = out.listed[0]!;
  expect(out.listed.length).toBe(1);
  expect(s).toMatchObject({ id: out.id, headline: "Central headline", outlets: 6, articles: 8, texts: 8 }); // 8 links, 6 owner groups
  expect(s.bias).toEqual({ left: 2, leanLeft: 1, center: 2, leanRight: 0, right: 0, unrated: 1 });
  expect(s.blindspot).toBe("right");
  expect(out.strict).toEqual([]);
  expect(out.blind.map((b) => b.id)).toEqual([out.id]);
  const d = Option.getOrThrow(out.detail);
  expect(d.sources.length).toBe(8);
  expect(d.sources.find((a) => a.domain === "kaaa.test")).toMatchObject({ family: "Stations", bias: "center", inherited: true });
  expect(d.sources.find((a) => a.domain === "news.l2.test")).toMatchObject({ outlet: "Left Two", bias: "lean-left" });
  expect(d.sources.find((a) => a.domain === "u.test")).toMatchObject({ outlet: "u.test", bias: null });
  expect(Option.isNone(out.missing)).toBe(true);
  expect(out.cov.total).toBeGreaterThan(0);
  expect(s.image).toBe("https://img.test/story.jpg"); // most common non-logo image
  expect(d.sources.find((a) => a.domain === "u.test")?.lede).toBe("A real first paragraph that is long enough to count as one."); // paywall lede replaced
  expect(out.unsorted).toEqual([{ topic: null, stories: 1 }]);
  expect(out.sorted).toEqual([{ topic: "politics", stories: 1 }]);
  expect(out.inTopic.map((x) => x.topic)).toEqual(["politics"]);
  expect(out.otherTopic).toEqual([]);
  expect(out.fresh.length).toBe(1);
  expect(out.stale).toEqual([]); // not updated within the window
});

import { fromScore, parseAllSides, parseFamilies, score, withAllSides } from "../src/outlets/consensus";

test("consensus: halves round toward the centre, AllSides matched by name or domain label", () => {
  expect(fromScore(-0.5)).toBe("center");
  expect(fromScore(0.5)).toBe("center");
  expect(fromScore(-1.5)).toBe("lean-left");
  expect(fromScore(1.6)).toBe("right");
  expect(score("left")).toBe(-2);
  const allsides = parseAllSides(
    "news_source,rating,type\nThe Hill,center,News Media\nCNN (Opinion),left,News Media\nFox News,right,News Media\nCNN (Online News),left-center,News Media\nMystery,allsides,News Media\n",
  );
  expect(allsides.map((a) => a.name)).toEqual(["The Hill", "Fox News", "CNN (Online News)"]); // opinion + unrated skipped
  const base = [
    { domain: "thehill.com", name: "x", bias: "lean-left" as const, factuality: null, country: null },
    { domain: "foxnews.com", name: "Fox News", bias: "lean-right" as const, factuality: null, country: null },
    { domain: "cnn.com", name: "CNN", bias: "lean-left" as const, factuality: null, country: null },
    { domain: "other.com", name: "Other", bias: "left" as const, factuality: null, country: null },
  ];
  const c = withAllSides(base, allsides);
  expect(c.rows.map((r) => r.bias)).toEqual(["center", "lean-right", "lean-left", "left"]); // lean-left+center -> center; lean-right+right -> lean-right (half toward centre)
  expect(c).toMatchObject({ matched: 3, disagreed: 2, changed: 1 });
  expect(c.spreads.get("foxnews.com")).toBe(1);
});

test("families csv: patterns may contain commas", () => {
  const { rules, errors } = parseFamilies("pattern,family,inherit_from,unrated_only,priority\n^\\d{2,4}x\\.com$,Radio,,true,40\n(,Bad,,true,1\n");
  expect(rules).toEqual([{ pattern: "^\\d{2,4}x\\.com$", family: "Radio", inheritFrom: null, unratedOnly: true, priority: 40 }]);
  expect(errors.length).toBe(1);
});
