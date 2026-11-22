import { Console, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";
import { serve } from "./api/Server";
import { migrate } from "./db/Db";
import { parseAllSides, parseFamilies, withAllSides } from "./outlets/consensus";
import { parseOutlets } from "./outlets/csv";
import { Outlets } from "./repos/Outlets";
import { defaultParams, paramsConfig, type ClusterParams } from "./cluster/params";
import { Cluster } from "./pipeline/Cluster";
import { Embed } from "./pipeline/Embed";
import { Ingest } from "./pipeline/Ingest";
import { Embeddings } from "./repos/Embeddings";
import { Stories } from "./repos/Stories";
import { FetchQueue } from "./queue/FetchQueue";
import { Schedulers } from "./queue/Schedulers";

const hours = Flag.Int("hours").pipe(Flag.withDescription("How far back GDELT ingestion looks"), Flag.withDefault(2));

const migrateCmd = Command.make("migrate", {}, () =>
  migrate.pipe(
    Effect.flatMap((applied) => Console.log(applied.length ? `applied ${applied.map(([, name]) => name).join(", ")}` : "migrations up to date")),
  ),
).pipe(Command.withDescription("Apply database migrations"));

const workerCmd = Command.make(
  "worker",
  {
    concurrency: Flag.Int("concurrency").pipe(Flag.withDescription("Parallel fetches"), Flag.withDefault(32)),
    hours,
  },
  ({ concurrency, hours }) =>
    Effect.gen(function* () {
      const fetchQueue = yield* FetchQueue;
      const requeued = yield* fetchQueue.requeueUnfinished;
      yield* Effect.log(`requeued ${requeued} unfinished urls`);
      yield* fetchQueue.start(concurrency);
      yield* (yield* Schedulers).start({ ingestHours: hours });
      yield* Effect.log(`worker running: fetch concurrency=${concurrency}; ingest every 15 min, embed every 30 s, cluster every 2 min`);
      return yield* Effect.never;
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Run the whole pipeline: fetch workers plus ingest, embed and cluster schedules"));

const ingestCmd = Command.make("ingest", { hours }, ({ hours }) =>
  Effect.gen(function* () {
    const total = yield* (yield* Ingest).run(hours);
    yield* Console.log(`done: ${total} new urls queued`);
  }),
).pipe(Command.withDescription("One-shot GDELT ingest (backfill); URLs are queued for the workers"));

const enqueueCmd = Command.make("enqueue", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(`requeued ${yield* (yield* FetchQueue).requeueUnfinished} unfinished urls`);
  }),
).pipe(Command.withDescription("Re-enqueue every unfinished URL from the ledger (after a crash or Redis loss)"));

const embedCmd = Command.make(
  "embed",
  {
    limit: Flag.Int("limit").pipe(Flag.withDescription("Max texts to embed"), Flag.optional),
    reset: Flag.Boolean("reset").pipe(Flag.withDescription("Drop all vectors first (after changing model, dimension or prefix)"), Flag.withDefault(false)),
  },
  ({ limit, reset }) =>
    Effect.gen(function* () {
      if (reset) {
        yield* (yield* Embeddings).reset;
        yield* Console.log("embeddings reset");
      }
      const n = yield* (yield* Embed).run(Option.getOrElse(limit, () => Infinity));
      yield* Console.log(`done: ${n} texts embedded`);
    }),
).pipe(Command.withDescription("Embed article texts with the configured model (Ollama)"));

const tuning = {
  join: Flag.Finite("join").pipe(Flag.withDescription("Join threshold (text -> story centroid)"), Flag.optional),
  seed: Flag.Finite("seed").pipe(Flag.withDescription("Seed threshold (text -> neighbour)"), Flag.optional),
  merge: Flag.Finite("merge").pipe(Flag.withDescription("Merge threshold (centroid -> centroid)"), Flag.optional),
  minOutlets: Flag.Int("min-outlets").pipe(Flag.withDescription("Distinct outlets a new story needs"), Flag.optional),
  gap: Flag.Finite("gap").pipe(Flag.withDescription("Max hours between a text and a story it joins"), Flag.optional),
};
const clusterCmd = Command.make(
  "cluster",
  { ...tuning, rebuild: Flag.Boolean("rebuild").pipe(Flag.withDescription("Wipe all stories and replay every text from the start"), Flag.withDefault(false)) },
  (a) =>
    Effect.gen(function* () {
      const base: ClusterParams = yield* paramsConfig;
      const p: ClusterParams = {
        joinSim: Option.getOrElse(a.join, () => base.joinSim),
        seedSim: Option.getOrElse(a.seed, () => base.seedSim),
        mergeSim: Option.getOrElse(a.merge, () => base.mergeSim),
        minOutlets: Option.getOrElse(a.minOutlets, () => base.minOutlets),
        maxGapHours: Option.getOrElse(a.gap, () => base.maxGapHours),
        seedK: base.seedK,
      };
      yield* Console.log("params", p);
      const stats = yield* (yield* Cluster).run(p, { rebuild: a.rebuild });
      yield* Console.log("done", stats);
    }),
).pipe(Command.withDescription("Cluster embedded texts into stories (incremental; --rebuild replays everything)"));

const pctLine = (xs: ReadonlyArray<number>) => (xs.length ? ["p5", "p25", "p50", "p75", "p95"].map((k, i) => `${k}=${xs[i]!.toFixed(2)}`).join(" ") : "(none)");

const storiesCmd = Command.make(
  "stories",
  {
    top: Flag.Int("top").pipe(Flag.withDescription("How many stories to show"), Flag.withDefault(15)),
    minOutlets: Flag.Int("min-outlets").pipe(Flag.withDescription("Only stories with at least this many outlets"), Flag.withDefault(defaultParams.minOutlets)),
    sims: Flag.Boolean("sims").pipe(Flag.withDescription("Also print similarity distributions"), Flag.withDefault(false)),
  },
  ({ top, minOutlets, sims }) =>
    Effect.gen(function* () {
      const stories = yield* Stories;
      const o = yield* stories.overview(minOutlets);
      yield* Console.log(`${o.texts} texts: ${o.assigned} in ${o.stories} stories, ${o.considered - o.assigned} noise, ${o.texts - o.considered} not yet considered`);
      yield* Console.log(`${o.shown} stories have >= ${minOutlets} outlets (${o.shownArticles} articles)`);
      yield* Console.log("story size (distinct texts):", (yield* stories.sizeHistogram).map((h) => `${h.bucket}: ${h.stories}`).join("  "));
      if (sims) {
        const s = yield* stories.simStats;
        yield* Console.log("text -> own centroid sim     ", pctLine(s.textToCentroid));
        yield* Console.log("nearest centroid -> centroid ", pctLine(s.centroidToCentroid));
      }
      for (const t of yield* stories.top(top, minOutlets)) {
        const hours = ((+t.lastSeen - +t.firstSeen) / 3_600_000).toFixed(1);
        yield* Console.log(`\n#${t.storyId}  ${t.outlets} outlets, ${t.articles} articles (${t.texts} distinct), span ${hours}h, member sim min ${t.minSim.toFixed(2)} avg ${t.avgSim.toFixed(2)}\n  ${t.headline}`);
        for (const a of yield* stories.sample(t.storyId, 4)) yield* Console.log(`    [${a.domain}] ${a.title.slice(0, 100)}  (${a.sim.toFixed(2)})`);
      }
    }),
).pipe(Command.withDescription("Inspect stories: counts, size histogram, top stories with sample headlines"));

const statusCmd = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Console.log("queue ", yield* (yield* FetchQueue).counts);
    yield* Console.log("ledger", Object.fromEntries((yield* sql<{ status: string; n: number }>`select fetch_status as status, count(*)::int as n from urls group by 1`).map((r) => [r.status, r.n])));
    const e = yield* (yield* Embeddings).stats;
    yield* Console.log("embeddings", `${e.embedded} embedded, ${e.unembedded} pending, ${e.centered} centred (mean v${e.meanVersion})`, e.variant ?? "(no variant yet)");
    const o = yield* (yield* Stories).overview(defaultParams.minOutlets);
    yield* Console.log("stories", `${o.stories} stories (${o.shown} with >= ${defaultParams.minOutlets} outlets), ${o.assigned} texts assigned, ${o.considered - o.assigned} noise, ${o.texts - o.considered} not yet clustered`);
    yield* Console.log("articles", (yield* sql<{ reject: string | null; n: number }>`select coalesce(reject_reason, 'usable') as reject, count(*)::int as n from articles group by 1`).map((r) => `${r.reject}=${r.n}`).join(" "));
  }),
).pipe(Command.withDescription("Queue, ledger and article counts"));

const serveCmd = Command.make(
  "serve",
  { port: Flag.Int("port").pipe(Flag.withDescription("HTTP port"), Flag.withDefault(3000)) },
  ({ port }) => Layer.launch(serve(port)),
).pipe(Command.withDescription("Serve the stories API and the one-page UI"));

const outletsImportCmd = Command.make(
  "import",
  {
    file: Flag.String("file").pipe(Flag.withDescription("CSV with domain,name,bias,factuality,country"), Flag.withDefault("data/outlets.csv")),
    families: Flag.String("families").pipe(Flag.withDescription("CSV of owner-group rules"), Flag.withDefault("data/families.csv")),
    crosscheck: Flag.String("crosscheck").pipe(Flag.withDescription("AllSideR allsides_data.csv to average in as a second rating source"), Flag.optional),
  },
  ({ file, families, crosscheck }) =>
    Effect.gen(function* () {
      const outlets = yield* Outlets;
      const { rows, errors } = parseOutlets(yield* Effect.promise(() => Bun.file(file).text()));
      for (const e of errors) yield* Console.log("skipped", e);
      let final = rows;
      let spreads = new Map<string, number>();
      if (Option.isSome(crosscheck)) {
        const c = withAllSides(rows, parseAllSides(yield* Effect.promise(() => Bun.file(crosscheck.value).text())));
        final = c.rows;
        spreads = new Map(c.spreads);
        yield* Console.log(`cross-check: ${c.matched} outlets matched, ${c.disagreed} disagree, ${c.changed} rating(s) moved to the average`);
      }
      yield* Console.log(`imported ${yield* outlets.replace(file, final, spreads)} outlets from ${file}`);
      const f = parseFamilies(yield* Effect.promise(() => Bun.file(families).text()));
      for (const e of f.errors) yield* Console.log("skipped", e);
      yield* Console.log(`loaded ${yield* outlets.setFamilies(f.rules)} owner-group rules from ${families}`);
    }),
).pipe(Command.withDescription("Load outlet ratings (optionally cross-checked) and owner-group rules"));

const outletsStatusCmd = Command.make("status", { top: Flag.Int("top").pipe(Flag.withDefault(15)) }, ({ top }) =>
  Effect.gen(function* () {
    const outlets = yield* Outlets;
    const c = yield* outlets.coverage;
    yield* Console.log(`${c.rated}/${c.total} outlets rated (${c.articlesRated}/${c.articlesTotal} articles)`);
    yield* Console.log("unrated outlets in most stories:", (yield* outlets.unrated(top, defaultParams.minOutlets)).map((u) => `${u.domain} (${u.stories})`).join(", "));
  }),
).pipe(Command.withDescription("How much of the collected news has a bias rating, and what to rate next"));

const outletsCmd = Command.make("outlets").pipe(Command.withDescription("Outlet bias ratings"), Command.withSubcommands([outletsImportCmd, outletsStatusCmd]));

export const news = Command.make("news").pipe(
  Command.withDescription("orbit news pipeline"),
  Command.withSubcommands([migrateCmd, workerCmd, ingestCmd, enqueueCmd, embedCmd, clusterCmd, storiesCmd, serveCmd, outletsCmd, statusCmd]),
);

export const cli = news.pipe(Command.run({ version: "0.2.0" }));
