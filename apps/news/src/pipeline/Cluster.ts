import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { centroidOf, addToCentroid } from "../cluster/vec";
import type { ClusterParams } from "../cluster/params";
import { ClusterStale } from "../errors";
import { Stories, type Neighbour, type Text } from "../repos/Stories";

/** Postgres NOTIFY channel fired after a clustering run changed stories. */
export const STORIES_CHANGED = "stories_changed";
const CHUNK = 200; // texts per transaction
const MERGE_ROUNDS = 3;
const HOUR = 3_600_000;

export interface ClusterStats {
  readonly considered: number;
  readonly joined: number;
  readonly seeded: number;
  readonly noise: number;
  readonly merges: number;
}

/**
 * Online clustering over distinct texts, ported from the archived open-news `incremental` strategy.
 * For each unconsidered text, oldest first:
 *   1. JOIN  the nearest live story (time-compatible) if sim >= joinSim; the centroid becomes the running mean.
 *   2. SEED  otherwise, from the nearest unassigned texts with sim >= seedSim, if together they cover at least
 *            `minOutlets` distinct outlets (so one wire story run by many outlets seeds on its own).
 *   3. NOISE otherwise; it stays unassigned and is found as a neighbour when a similar text arrives.
 * Then a merge pass folds together stories whose centroids converged.
 */
export class Cluster extends Context.Service<Cluster, {
  /** Cluster everything not yet considered. `rebuild` wipes all story state first and replays from the start. */
  run(p: ClusterParams, opts?: { readonly rebuild?: boolean }): Effect.Effect<ClusterStats, ClusterStale>;
}>()("news/pipeline/Cluster") {
  static readonly layer = Layer.effect(
    Cluster,
    Effect.gen(function* () {
      const stories = yield* Stories;
      const sql = yield* SqlClient.SqlClient;

      const chunk = (texts: ReadonlyArray<Text>, p: ClusterParams, meanVersion: number) =>
        Effect.gen(function* () {
          yield* stories.begin;
          const gap = p.maxGapHours * HOUR;
          const done = new Set<string>();
          const touched = new Set<number>();
          const stats = { considered: 0, joined: 0, seeded: 0, noise: 0, merges: 0 };

          for (const t of texts) {
            if (done.has(t.embedKey)) continue; // assigned earlier in this chunk as someone's neighbour
            stats.considered++;

            const near = yield* stories.nearest(t.vec, t.firstSeen, gap);
            if (Option.isSome(near) && near.value.sim >= p.joinSim) {
              const n = near.value;
              yield* stories.join(n.id, t.embedKey, n.sim, addToCentroid(n.centroid, n.n, t.vec), n.n + 1, t.firstSeen);
              yield* stories.markSeen([t.embedKey]);
              done.add(t.embedKey);
              touched.add(n.id);
              stats.joined++;
              continue;
            }

            const close: Neighbour[] = (yield* stories.neighbours(t.embedKey, t.vec, p.seedK)).filter(
              (x) => x.sim >= p.seedSim && !done.has(x.embedKey) && Math.abs(+x.firstSeen - +t.firstSeen) <= gap,
            );
            const outlets = new Set([...t.domains, ...close.flatMap((x) => x.domains)]).size;
            if (outlets >= p.minOutlets) {
              const members = [t, ...close];
              const id = yield* stories.create(
                [{ key: t.embedKey, sim: 1 }, ...close.map((x) => ({ key: x.embedKey, sim: x.sim }))],
                centroidOf(members.map((m) => m.vec)),
                new Date(Math.min(...members.map((m) => +m.firstSeen))),
                new Date(Math.max(...members.map((m) => +m.firstSeen))),
                meanVersion,
              );
              yield* stories.markSeen(members.map((m) => m.embedKey));
              for (const m of members) done.add(m.embedKey);
              touched.add(id);
              stats.seeded++;
            } else {
              yield* stories.markSeen([t.embedKey]);
              done.add(t.embedKey);
              stats.noise++;
            }
          }

          // Merge pass: fold a touched story into its nearest neighbour when their centroids converged.
          let ids = [...touched];
          for (let round = 0; round < MERGE_ROUNDS && ids.length > 0; round++) {
            const pairs = yield* stories.mergeTargets(ids, p.mergeSim, gap);
            const used = new Set<number>();
            const next = new Set<number>();
            for (const pair of pairs) {
              if (used.has(pair.a) || used.has(pair.b)) continue;
              const [a, b] = yield* Effect.all([stories.story(pair.a), stories.story(pair.b)]);
              const [keep, drop] = a.n >= b.n ? [a, b] : [b, a];
              yield* stories.merge(keep, drop);
              used.add(pair.a).add(pair.b);
              next.add(keep.id);
              stats.merges++;
            }
            ids = [...next];
          }
          return stats;
        });

      const run = Effect.fn("Cluster.run")(function* (p: ClusterParams, opts?: { readonly rebuild?: boolean }) {
        if (opts?.rebuild) yield* stories.reset;
        const meanVersion = yield* stories.meanVersion;
        if (meanVersion === 0) return yield* new ClusterStale({ message: "embeddings have no frozen mean yet: run `embed` first" });
        if ((yield* stories.staleStories) > 0) return yield* new ClusterStale({ message: "stories were built on an older corpus mean: run `cluster --rebuild`" });

        const total = { considered: 0, joined: 0, seeded: 0, noise: 0, merges: 0 };
        const t0 = performance.now();
        while (true) {
          const texts = yield* stories.fresh(CHUNK);
          if (texts.length === 0) break;
          const s = yield* sql.withTransaction(chunk(texts, p, meanVersion)).pipe(Effect.orDie);
          for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
          const secs = (performance.now() - t0) / 1000;
          yield* Effect.log(`clustered ${total.considered} texts (${total.joined} joined, ${total.seeded} new stories, ${total.noise} noise, ${total.merges} merges) @ ${(total.considered / secs).toFixed(0)}/s`);
        }
        // Tell listeners (the API's /events stream) that story pages changed. Best effort: a failed notify must not fail clustering.
        if (total.joined + total.seeded + total.merges > 0) {
          yield* sql`select pg_notify(${STORIES_CHANGED}, ${JSON.stringify({ joined: total.joined, seeded: total.seeded, merges: total.merges })})`.pipe(Effect.ignore);
        }
        return total as ClusterStats;
      });

      return Cluster.of({ run });
    }),
  );
}
