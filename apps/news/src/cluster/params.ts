import { Config } from "effect";

/**
 * Clustering thresholds. They are cosine similarities between *mean-centred* embeddinggemma vectors (no prefix).
 * Calibrated on hand-labelled pairs: same-event pairs score ~0.65-0.75 (min 0.46), the hardest different-event
 * pairs top out at ~0.56. Article-to-centroid and centroid-to-centroid sit on different scales, so they are
 * separate knobs; re-measure with `stories --sims` after a rebuild.
 */
export interface ClusterParams {
  /** Text joins the nearest live story if its similarity to the centroid is at least this. */
  readonly joinSim: number;
  /** Neighbours at least this similar to a text can seed a new story together with it. */
  readonly seedSim: number;
  /** Stories whose centroids are at least this similar are folded together. */
  readonly mergeSim: number;
  /** A new story needs articles from at least this many distinct outlets. */
  readonly minOutlets: number;
  /** Joining/seeding only considers stories and texts within this many hours of each other. */
  readonly maxGapHours: number;
  /** How many nearest unassigned texts are examined when seeding. */
  readonly seedK: number;
}

/**
 * Tuned by eye on ~4.2k distinct texts (one weekend of GDELT), by reading the loosest stories after `cluster --rebuild`:
 *  - join 0.55 / seed 0.62: topical wrong merges (local car crashes, NHL results, shootings) bottomed out at member sim 0.55-0.56.
 *  - join 0.66 / seed 0.70: those splits disappear; what remains loose is legitimate (obituaries, a wedding) for ~5% fewer articles.
 *  - merge 0.75: the closest centroid pairs mix true fragments (UN climate talks 0.69-0.71, weather 0.80) with different
 *    events using the same boilerplate (two "TV & Stream" game listings, 0.72); 0.75 only takes the safe one.
 *    Known limitation: some same-event stories stay split.
 */
export const defaultParams: ClusterParams = { joinSim: 0.66, seedSim: 0.7, mergeSim: 0.75, minOutlets: 3, maxGapHours: 36, seedK: 20 };

export const paramsConfig: Config.Config<ClusterParams> = Config.all({
  joinSim: Config.Number("CLUSTER_JOIN_SIM").pipe(Config.withDefault(defaultParams.joinSim)),
  seedSim: Config.Number("CLUSTER_SEED_SIM").pipe(Config.withDefault(defaultParams.seedSim)),
  mergeSim: Config.Number("CLUSTER_MERGE_SIM").pipe(Config.withDefault(defaultParams.mergeSim)),
  minOutlets: Config.Int("CLUSTER_MIN_OUTLETS").pipe(Config.withDefault(defaultParams.minOutlets)),
  maxGapHours: Config.Number("CLUSTER_MAX_GAP_HOURS").pipe(Config.withDefault(defaultParams.maxGapHours)),
  seedK: Config.Int("CLUSTER_SEED_K").pipe(Config.withDefault(defaultParams.seedK)),
});
