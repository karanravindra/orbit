import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { addToCentroid, centroidOf, dot, fromPg, normalize, toPg } from "../src/cluster/vec";
import { defaultParams } from "../src/cluster/params";
import { ClusterStale } from "../src/errors";
import { Cluster } from "../src/pipeline/Cluster";
import { Stories } from "../src/repos/Stories";
import { dbUp, rolledBack } from "./helpers";

test("vec: normalize, centroid and running mean", () => {
  const n = normalize(Float32Array.from([3, 4]));
  expect(Array.from(n).map((x) => +x.toFixed(3))).toEqual([0.6, 0.8]);
  const c = centroidOf([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  expect(dot(c, c)).toBeCloseTo(1, 5);
  // folding a vector into a centroid built from n vectors equals the mean of all n+1
  const a = Float32Array.from([1, 0]), b = Float32Array.from([0, 1]), d = Float32Array.from([1, 1]);
  const inc = addToCentroid(centroidOf([a, b]), 2, normalize(d));
  const batch = centroidOf([normalize(a), normalize(b), normalize(d)]);
  expect(dot(inc, batch)).toBeGreaterThan(0.99);
  expect(Array.from(fromPg(toPg(Float32Array.from([0.5, -0.25]))))).toEqual([0.5, -0.25]);
});

// ---- real Postgres, rolled back: synthetic events as near-axis unit vectors ----
const DIM = 768;
/** Unit vector near axis `event`, nudged along a private axis so same-event texts are ~0.99 similar, other events ~0. */
const vecFor = (event: number, variant: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[event] = 1;
  v[100 + variant] = 0.1;
  return normalize(v);
};
const HOUR = 3_600_000;
const T0 = Date.parse("2030-01-01T00:00:00Z");

const Live = Cluster.layer.pipe(Layer.provideMerge(Stories.layer));

test.skipIf(!dbUp)("Cluster: seeds events, joins late texts, respects the time gap, leaves noise, needs outlets", async () => {
  const out = await rolledBack(
    Live,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cluster = yield* Cluster;
      yield* sql`delete from embeddings`; // cascades to story_texts / cluster_seen; everything is rolled back at the end
      yield* sql`delete from stories`;
      yield* sql`insert into embedding_state (id, variant, mean_version) values (1, 't', 1) on conflict (id) do update set mean_version = 1`;

      let k = 0;
      const add = (event: number, variant: number, domain: string, hoursFromStart: number, tag: string) =>
        Effect.gen(function* () {
          const title = `${tag} ${k++}`;
          const url = `https://synthetic.test/${crypto.randomUUID()}`;
          const seen = new Date(T0 + hoursFromStart * HOUR);
          yield* sql`insert into urls (url, domain, seen_at) values (${url}, ${domain}, ${seen})`;
          yield* sql`insert into articles (url, domain, title, lede, seen_at) values (${url}, ${domain}, ${title}, 'lede', ${seen})`;
          const [r] = yield* sql<{ embedKey: string }>`select embed_key from articles where url = ${url}`;
          const v = toPg(vecFor(event, variant));
          yield* sql`insert into embeddings (embed_key, vec, cvec) values (${r!.embedKey}, ${v}::vector, ${v}::vector)`;
          return r!.embedKey;
        });

      // event 0: three outlets seed it; a fourth text arrives 37h later (outside the seed window, inside the story's gap) and joins
      const a1 = yield* add(0, 1, "a.com", 0, "A");
      const a2 = yield* add(0, 2, "b.com", 1, "A");
      const a3 = yield* add(0, 3, "c.com", 2, "A");
      const a4 = yield* add(0, 4, "d.com", 37, "A");
      // event 1: wire copy: ONE distinct text carried by three outlets still makes a story
      const wire = yield* add(1, 5, "x.com", 3, "W");
      yield* sql`insert into urls (url, domain, seen_at) values ('https://y.test/w', 'y.com', ${new Date(T0 + 3 * HOUR)}), ('https://z.test/w', 'z.com', ${new Date(T0 + 3 * HOUR)})`;
      yield* sql`insert into articles (url, domain, title, lede, seen_at)
                 select u.url, u.domain, a.title, a.lede, a.seen_at from urls u, articles a where u.url in ('https://y.test/w', 'https://z.test/w') and a.embed_key = ${wire}`;
      // same direction as event 0 but five days later: a different story, not a join
      const later = [yield* add(0, 6, "a.com", 120, "L"), yield* add(0, 7, "b.com", 121, "L"), yield* add(0, 8, "c.com", 122, "L")];
      // event 2: only two outlets: below minOutlets, stays noise
      const thin = [yield* add(2, 9, "p.com", 5, "T"), yield* add(2, 10, "q.com", 6, "T")];
      // event 3: a lone text
      const lone = yield* add(3, 11, "r.com", 7, "N");

      const stats = yield* cluster.run(defaultParams);
      const storyOf = (key: string) => sql<{ storyId: number }>`select story_id from story_texts where embed_key = ${key}`.pipe(Effect.map((r) => (r[0] ? Number(r[0].storyId) : null)), Effect.orDie);
      const ids = {
        a: [yield* storyOf(a1), yield* storyOf(a2), yield* storyOf(a3), yield* storyOf(a4)],
        wire: yield* storyOf(wire),
        later: [yield* storyOf(later[0]!), yield* storyOf(later[1]!), yield* storyOf(later[2]!)],
        thin: [yield* storyOf(thin[0]!), yield* storyOf(thin[1]!)],
        lone: yield* storyOf(lone),
      };
      const rerun = yield* cluster.run(defaultParams); // nothing left to do
      const nStories = (yield* sql<{ n: number }>`select count(*)::int as n from stories`)[0]!.n;
      const centroidNorm = (yield* sql<{ c: string }>`select centroid::text as c from stories limit 1`)[0]!.c;
      yield* sql`update stories set mean_version = 2`;
      const stale = yield* cluster.run(defaultParams).pipe(Effect.flip);
      return { stats, ids, rerun, nStories, centroidNorm: Math.hypot(...fromPg(centroidNorm)), stale };
    }).pipe(Effect.orDie),
  );

  const { ids } = out;
  expect(new Set(ids.a).size).toBe(1); // all four texts of event 0 in one story (3 seeded + 1 joined)
  expect(ids.a[0]).not.toBeNull();
  expect(ids.wire).not.toBeNull(); // wire copy: one text, three outlets
  expect(ids.wire).not.toBe(ids.a[0]);
  expect(new Set(ids.later).size).toBe(1); // later burst is its own story ...
  expect(ids.later[0]).not.toBeNull();
  expect(ids.later[0]).not.toBe(ids.a[0]); // ... because of the 36h gap
  expect(ids.thin).toEqual([null, null]); // two outlets < minOutlets
  expect(ids.lone).toBeNull();
  expect(out.nStories).toBe(3);
  expect(out.stats).toMatchObject({ joined: 1, seeded: 3 });
  expect(out.rerun.considered).toBe(0);
  expect(out.centroidNorm).toBeCloseTo(1, 4);
  expect(out.stale).toBeInstanceOf(ClusterStale);
});
