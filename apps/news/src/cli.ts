import { Console, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";
import { serve } from "./api/Server";
import { migrate } from "./db/Db";
import { parseAllSides, parseFamilies, withAllSides } from "./outlets/consensus";
import { parseOutlets } from "./outlets/csv";
import { Outlets } from "./repos/Outlets";
import { defaultParams, paramsConfig, type ClusterParams } from "./cluster/params";
import { Backfill } from "./pipeline/Backfill";
import { Cluster } from "./pipeline/Cluster";
import { Summarizer } from "./summaries/Summarizer";
import { Embed } from "./pipeline/Embed";
import { Ingest } from "./pipeline/Ingest";
import { Reports } from "./pipeline/Reports";
import { Summaries } from "./pipeline/Summaries";
import { Topics } from "./pipeline/Topics";
import { Classifier } from "./topics/Classifier";
import { TOPICS } from "./topics/taxonomy";
import { formatGold, parseGold, score, type GoldItem } from "./gold/gold";
import { Feed } from "./repos/Feed";
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

const imagesCmd = Command.make(
  "images",
  { limit: Flag.Int("limit").pipe(Flag.withDescription("Max pages to fetch"), Flag.withDefault(800)) },
  ({ limit }) =>
    Effect.gen(function* () {
      const [looked, found] = yield* (yield* Backfill).images(limit);
      yield* Console.log(`looked at ${looked} pages, found ${found} images`);
    }),
).pipe(Command.withDescription("Backfill share images for articles in stories (new articles get theirs at fetch time)"));

const topicsCmd = Command.make(
  "topics",
  {
    all: Flag.Boolean("all").pipe(Flag.withDescription("Reclassify every recent story, not just new or grown ones"), Flag.withDefault(false)),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Max stories to classify"), Flag.withDefault(500)),
  },
  ({ all, limit }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const s = yield* (yield* Topics).run({ all, limit });
      yield* Console.log(`candidates ${s.candidates}, inherited ${s.inherited}, classified ${s.classified}, parked ${s.pending}, failed ${s.failed}`);
      const rows = yield* sql<{ topic: string | null; n: number }>`select topic, count(*)::int as n from stories group by 1 order by 2 desc`;
      yield* Console.log(rows.map((r) => `${r.topic ?? "-"}=${r.n}`).join(" "));
    }),
).pipe(Command.withDescription("Classify stories into sections with the local model"));

const cleanCmd = Command.make("clean", {}, () =>
  Effect.gen(function* () {
    const backfill = yield* Backfill;
    const [fixed, rejected] = yield* backfill.cleanLedes;
    const q = yield* backfill.quality;
    yield* Console.log(`fixed ${fixed} paywall ledes, rejected ${rejected} paywalled stubs`);
    yield* Console.log(`rejected as not news reports: ${Object.entries(q).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`);
    yield* Console.log("now run: embed, then cluster --rebuild (only needed if ledes changed)");
  }),
).pipe(Command.withDescription("Repair paywall ledes and reject press releases, roundups and listicles stored before those filters existed"));

const reportsCmd = Command.make(
  "reports",
  { all: Flag.Boolean("all").pipe(Flag.withDescription("Recompute every recent story"), Flag.withDefault(false)) },
  ({ all }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const s = yield* (yield* Reports).run({ all });
      yield* Console.log(`${s.changed} stories updated`);
      const rows = yield* sql<{ id: number; indep: number; texts: number; outlets: number }>`
        select g.id, g.indep, g.indep_texts as texts,
               (select count(distinct a.domain)::int from story_texts t join articles a on a.embed_key = t.embed_key and a.reject_reason is null where t.story_id = g.id) as outlets
        from stories g where g.indep is not null order by g.indep_texts desc limit 8`;
      for (const r of rows) yield* Console.log(`#${r.id}: ${r.outlets} outlets, ${r.texts} texts, ${r.indep} independent reports`);
    }),
).pipe(Command.withDescription("Count independent reports per story (wire copies folded together)"));

const summarizeCmd = Command.make(
  "summarize",
  {
    story: Flag.Int("story").pipe(Flag.withDescription("Write the summary for one story id"), Flag.optional),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Rewrite even if the current summary is up to date"), Flag.withDefault(false)),
    budget: Flag.Int("seconds").pipe(Flag.withDescription("Time budget for a pass over the most visible stories"), Flag.withDefault(120)),
  },
  ({ story, force, budget }) =>
    Effect.gen(function* () {
      const summaries = yield* Summaries;
      yield* (yield* Summarizer).warm;
      if (Option.isSome(story)) {
        const wrote = yield* summaries.write(story.value, force).pipe(Effect.catch((e) => Console.log(`failed: ${e.message}`).pipe(Effect.as(false))));
        const d = Option.getOrNull(yield* (yield* Feed).get(story.value));
        yield* Console.log(wrote ? "written:" : "unchanged:", d?.summary ?? "(none)");
        return;
      }
      const s = yield* summaries.run({ budgetMs: budget * 1000, max: 1000 });
      yield* Console.log(`demand ${s.demand}, scheduled ${s.scheduled}, failed ${s.failed}, up to date ${s.skipped}`);
    }),
).pipe(Command.withDescription("Write summaries now: one story (--story), or a pass over the most visible stories lacking one"));

const GOLD_FILE = "data/gold/topics.jsonl";
const goldSampleCmd = Command.make(
  "sample",
  { n: Flag.Int("n").pipe(Flag.withDescription("Stories to add"), Flag.withDefault(200)), file: Flag.String("file").pipe(Flag.withDefault(GOLD_FILE)) },
  ({ n, file }) =>
    Effect.gen(function* () {
      const have = (yield* Effect.promise(() => Bun.file(file).exists())) ? parseGold(yield* Effect.promise(() => Bun.file(file).text())) : [];
      const taken = new Set(have.map((g) => g.key));
      const fresh = (yield* (yield* Topics).inputs({ all: true, limit: n * 3, random: true, days: 30 })).filter((i) => !taken.has(i.headlineKey)).slice(0, n);
      const items: GoldItem[] = [...have, ...fresh.map((i) => ({ key: i.headlineKey, headline: i.headline, titles: i.titles, label: null }))];
      yield* Effect.promise(() => Bun.write(file, formatGold(items)));
      yield* Console.log(`${file}: ${items.length} stories (${fresh.length} new, ${items.filter((i) => !i.label).length} unlabelled). Label them with: gold label`);
    }),
).pipe(Command.withDescription("Draw a random sample of stories into the gold file (unlabelled)"));

const goldLabelCmd = Command.make("label", { file: Flag.String("file").pipe(Flag.withDefault(GOLD_FILE)) }, ({ file }) =>
  Effect.gen(function* () {
    const items = parseGold(yield* Effect.promise(() => Bun.file(file).text()));
    const keys = "1234567890";
    const legend = TOPICS.map((t, i) => `${keys[i]}=${t.id}`).join("  ");
    const ask = (q: string) => Effect.promise(async () => (prompt(q) ?? "q").trim().toLowerCase());
    let done = 0;
    for (const it of items) {
      if (it.label) continue;
      yield* Console.log(`\n${items.filter((i) => i.label).length}/${items.length} labelled\n  ${it.headline}\n${it.titles.map((t) => `    - ${t}`).join("\n")}\n  ${legend}   s=skip  q=quit`);
      const a = yield* ask("section: ");
      if (a === "q") break;
      const idx = keys.indexOf(a.slice(0, 1));
      if (a === "s" || idx < 0 || idx >= TOPICS.length) continue;
      const b = a.length > 1 ? keys.indexOf(a.slice(1, 2)) : -1; // "26" = label 2, also acceptable 6
      (items as GoldItem[])[items.indexOf(it)] = { ...it, label: TOPICS[idx]!.id, alt: b >= 0 && b < TOPICS.length ? TOPICS[b]!.id : null };
      done++;
      yield* Effect.promise(() => Bun.write(file, formatGold(items)));
    }
    yield* Console.log(`labelled ${done} this session; ${items.filter((i) => i.label).length}/${items.length} total`);
  }),
).pipe(Command.withDescription("Label gold stories in the terminal: press a number (two digits = label + also-acceptable)"));

const goldEvalCmd = Command.make(
  "eval",
  {
    file: Flag.String("file").pipe(Flag.withDefault(GOLD_FILE)),
    model: Flag.String("model").pipe(Flag.withDescription("Override TOPIC_MODEL to compare models"), Flag.optional),
    misses: Flag.Boolean("misses").pipe(Flag.withDescription("List every strict miss"), Flag.withDefault(false)),
  },
  ({ file, model, misses }) =>
    Effect.gen(function* () {
      const labelled = parseGold(yield* Effect.promise(() => Bun.file(file).text())).filter((g) => g.label);
      if (labelled.length === 0) return yield* Console.log("no labelled stories: run gold sample, then gold label");
      const base = yield* Classifier;
      const c = Option.isSome(model) ? yield* Classifier.make({ baseUrl: process.env.TOPIC_BASE_URL ?? "http://localhost:11434", model: model.value }) : base;
      const rows = yield* Effect.forEach(labelled, (g) => c.classify(g.headline, g.titles).pipe(Effect.map((predicted) => ({ ...g, label: g.label!, predicted })), Effect.catch(() => Effect.succeed({ ...g, label: g.label!, predicted: "error" }))), { concurrency: 4 });
      const r = score(rows);
      yield* Console.log(`${c.model} on ${r.n} stories: strict ${(r.strict * 100).toFixed(1)}%  lenient ${(r.lenient * 100).toFixed(1)}%`);
      for (const t of r.perTopic) yield* Console.log(`  ${t.topic.padEnd(14)} n=${String(t.support).padEnd(3)} precision ${(t.precision * 100).toFixed(0)}%  recall ${(t.recall * 100).toFixed(0)}%`);
      yield* Console.log("top confusions:", r.confusions.map((x) => `${x.gold}->${x.predicted} x${x.count}`).join(", ") || "none");
      if (misses) for (const m of rows.filter((x) => x.predicted !== x.label)) yield* Console.log(`  [${m.label}${m.alt ? "/" + m.alt : ""} -> ${m.predicted}] ${m.headline}`);
    }),
).pipe(Command.withDescription("Score the topic classifier against the labelled gold set"));

const goldCmd = Command.make("gold").pipe(Command.withDescription("Hand-labelled topic evaluation set"), Command.withSubcommands([goldSampleCmd, goldLabelCmd, goldEvalCmd]));

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
  Command.withSubcommands([migrateCmd, workerCmd, ingestCmd, enqueueCmd, embedCmd, clusterCmd, storiesCmd, serveCmd, imagesCmd, topicsCmd, reportsCmd, summarizeCmd, goldCmd, cleanCmd, outletsCmd, statusCmd]),
);

export const cli = news.pipe(Command.run({ version: "0.2.0" }));
