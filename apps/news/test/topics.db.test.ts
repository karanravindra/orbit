import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { toPg } from "../src/cluster/vec";
import { Reports } from "../src/pipeline/Reports";
import { Topics } from "../src/pipeline/Topics";
import { Classifier } from "../src/topics/Classifier";
import type { TopicId } from "../src/topics/taxonomy";
import { dbUp, rolledBack } from "./helpers";

const T = new Date("2030-03-01T00:00:00Z");
const WIRE = "The Senate on Friday passed a sweeping budget bill after an overnight session that stretched into the morning hours, sending it to the House.";

const ORIGINAL = [
  "Democrats warned that cuts to health programs would raise premiums for millions of families, while hospital administrators described layoffs they expect by spring.",
  "Bond markets reacted calmly as analysts said yields barely moved, and economists pointed to inflation data due on Tuesday as the real test for investors.",
  "In rural counties, school boards said the changes could close two campuses, and farmers worried about subsidies that had been promised before the election.",
];

/** A story of `n` distinct texts from distinct domains; the first `copies` share one wire lede, the rest are original. */
const seedStory = (n: number, copies: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const vec = (i: number) => { const v = new Float32Array(768); v[0] = 1; v[1 + i] = 0.2; return toPg(v); };
    const [{ id }] = (yield* sql<{ id: number }>`insert into stories (centroid, n, first_seen, last_seen, mean_version) values (${vec(-1 + 1)}::vector, ${n}, ${T}, ${T}, 1) returning id`) as [{ id: number }];
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const url = `https://d${i}.test/${id}-${i}`;
      const lede = i < copies ? WIRE : ORIGINAL[i % ORIGINAL.length]!;
      yield* sql`insert into urls (url, domain, seen_at) values (${url}, ${`d${i}.test`}, ${T})`;
      yield* sql`insert into articles (url, domain, title, lede, seen_at) values (${url}, ${`d${i}.test`}, ${`Headline ${i} | Site ${i}`}, ${lede}, ${T})`;
      const [r] = yield* sql<{ embedKey: string }>`select embed_key from articles where url = ${url}`;
      yield* sql`insert into embeddings (embed_key, vec, cvec) values (${r!.embedKey}, ${vec(i)}::vector, ${vec(i)}::vector)`;
      yield* sql`insert into story_texts (embed_key, story_id, sim) values (${r!.embedKey}, ${id}, 0.9)`;
      keys.push(r!.embedKey);
    }
    return { id: Number(id), keys };
  });

test.skipIf(!dbUp)("Topics: votes survive a rebuild, one disagreeing answer is parked, a second flips", async () => {
  let answer: TopicId = "politics";
  let calls = 0;
  const StubClassifier = Layer.succeed(Classifier, Classifier.of({ model: "stub", classify: () => Effect.sync(() => { calls++; return answer; }) }));
  const out = await rolledBack(
    Topics.layer.pipe(Layer.provideMerge(StubClassifier)),
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const topics = yield* Topics;
      yield* sql`delete from embeddings`;
      yield* sql`delete from stories`;
      const { id } = yield* seedStory(5, 0);
      const topic = () => sql<{ topic: string | null; pending: string | null }>`select topic, topic_pending as pending from stories where id = ${id}`.pipe(Effect.map((r) => r[0]!));

      const first = yield* topics.run();
      const afterFirst = yield* topic();
      const votes = (yield* sql<{ n: number }>`select count(*)::int as n from text_topics where topic = 'politics'`)[0]!.n;

      // one disagreeing answer after the story doubled: parked, not applied
      yield* sql`update stories set topic_texts = 1`;
      answer = "business";
      const second = yield* topics.run();
      const afterSecond = yield* topic();
      // the same disagreement again: now it flips
      yield* sql`update stories set topic_texts = 1`;
      const third = yield* topics.run();
      const afterThird = yield* topic();

      // a rebuild truncates stories and ids; a story built from the same texts inherits the voted section with no model call
      const before = calls;
      yield* sql`update stories set topic = null, topic_pending = null, topic_texts = null`;
      const inheritedRun = yield* topics.run();
      const afterInherit = yield* topic();
      return { first, afterFirst, votes, second, afterSecond, third, afterThird, inheritedRun, afterInherit, callsDuringInherit: calls - before };
    }).pipe(Effect.orDie),
  );
  expect(out.first).toMatchObject({ classified: 1, pending: 0 });
  expect(out.afterFirst).toEqual({ topic: "politics", pending: null });
  expect(out.votes).toBe(5); // headline + four others
  expect(out.second).toMatchObject({ classified: 0, pending: 1 });
  expect(out.afterSecond).toEqual({ topic: "politics", pending: "business" });
  expect(out.third).toMatchObject({ classified: 1 });
  expect(out.afterThird).toEqual({ topic: "business", pending: null });
  expect(out.inheritedRun.inherited).toBe(1);
  expect(out.afterInherit.topic).toBe("business"); // the latest votes (written when it flipped) now outweigh the old ones
  expect(out.callsDuringInherit).toBe(0);
});

test.skipIf(!dbUp)("Reports: wire copies fold into one independent report, and are recomputed only when the story size changes", async () => {
  const out = await rolledBack(
    Reports.layer,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reports = yield* Reports;
      yield* sql`delete from embeddings`;
      yield* sql`delete from stories`;
      const { id } = yield* seedStory(6, 4); // 4 copies of one wire lede + 2 original reports
      const first = yield* reports.run();
      const [row] = yield* sql<{ indep: number; indepTexts: number }>`select indep, indep_texts from stories where id = ${id}`;
      const again = yield* reports.run();
      return { first, row: row!, again };
    }).pipe(Effect.orDie),
  );
  expect(out.row).toEqual({ indep: 3, indepTexts: 6 });
  expect(out.first.stories).toBeGreaterThanOrEqual(1);
  expect(out.again.stories).toBe(0);
});
