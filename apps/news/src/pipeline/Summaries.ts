import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { SummarizeError } from "../errors";
import { wireGroups } from "../cluster/wire";
import { cleanTitle } from "../extract/headline";
import { Embeddings } from "../repos/Embeddings";
import { Feed } from "../repos/Feed";
import { PROMPT_VERSION, type SourceText } from "../summaries/prompt";
import { Summarizer } from "../summaries/Summarizer";

/** Postgres NOTIFY channel fired when a summary was written (payload: story id), so open pages can swap it in. */
export const SUMMARY_READY = "summary_ready";

const MAX_SOURCES = 4; // independent reports sent to the model
const SOURCE_CHARS = 1100; // per report: prefill dominates cost, and the lede-heavy start of an article carries the facts
const PRE_TOP = 24; // pre-write the N most important stories ...
const PRE_PER_TOPIC = 6; // ... and the front-page row of each section (what a visitor sees without clicking)
const SCAN_EVERY_MS = 120_000;
const TICK_BUDGET_MS = 40_000;
const MAX_PER_TICK = 8;
const EMBED_BACKLOG_PAUSE = 300; // embedding feeds clustering: it gets the GPU first
const REWRITE_MIN_AGE_MS = 30 * 60_000;
const MAX_FAILURES = 5;

export interface SummaryStats {
  readonly demand: number;
  readonly scheduled: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface Existing {
  readonly inputHash: string;
  readonly model: string;
  readonly version: number;
  readonly indep: number;
  readonly generatedAt: Date;
}

/**
 * When is an existing summary worth rewriting? Only when coverage changed materially: a new prompt/model, or the story
 * gained >= 3 independent reports and grew by half, and the last write is at least 30 min old. A trickle of copies or one
 * extra outlet never costs a generation.
 */
export const shouldRewrite = (existing: Existing | null, now: { readonly hash: string; readonly model: string; readonly indep: number }, at: number = Date.now()): boolean => {
  if (!existing) return true;
  if (existing.inputHash === now.hash) return false;
  if (existing.version !== PROMPT_VERSION || existing.model !== now.model) return true;
  return now.indep >= existing.indep + 3 && now.indep >= 1.5 * existing.indep && at - +existing.generatedAt >= REWRITE_MIN_AGE_MS;
};

interface Candidate {
  readonly embedKey: string;
  readonly domain: string;
  readonly outlet: string | null;
  readonly sitename: string | null;
  readonly title: string;
  readonly lede: string | null;
  readonly body: string | null;
  readonly bias: string | null;
  readonly factuality: string | null;
  readonly dist: number;
}

const FACT = { high: 3, mostly: 2, "mostly-factual": 2, mixed: 1, low: 0 } as Record<string, number>;
const side = (bias: string | null) => (bias === "left" || bias === "lean-left" ? "L" : bias === "right" || bias === "lean-right" ? "R" : bias === "center" ? "C" : "?");

/**
 * One text per independent report (wire copies folded), at most MAX_SOURCES, spread across the political spectrum so the
 * summary is not just one side's framing; most central report first.
 */
export const pickSources = (cands: ReadonlyArray<Candidate>): ReadonlyArray<Candidate> => {
  const groups = wireGroups(cands.map((c) => c.lede || c.title));
  const reps = new Map<number, Candidate>();
  cands.forEach((c, i) => {
    const g = groups[i]!;
    const cur = reps.get(g);
    const score = (x: Candidate) => (FACT[x.factuality ?? ""] ?? 1) * 10_000 + Math.min(x.body?.length ?? 0, 5_000);
    if (!cur || score(c) > score(cur)) reps.set(g, c);
  });
  const ordered = [...reps.values()].sort((a, b) => a.dist - b.dist);
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of ordered) {
    if (picked.length >= MAX_SOURCES) break;
    if (!seen.has(side(c.bias))) {
      picked.push(c);
      seen.add(side(c.bias));
    }
  }
  for (const c of ordered) if (picked.length < MAX_SOURCES && !picked.includes(c)) picked.push(c);
  return picked.sort((a, b) => a.dist - b.dist);
};

const toSource = (c: Candidate): SourceText => ({
  outlet: c.outlet ?? c.domain,
  title: cleanTitle(c.title, c.sitename, c.domain),
  text: (c.body && c.body.length > 200 ? c.body : (c.lede ?? c.body ?? "")).slice(0, SOURCE_CHARS),
});

export class Summaries extends Context.Service<Summaries, {
  /** One tick of the writer: requested stories first, then the most visible stories lacking a current summary, within a time budget. */
  run(opts?: { readonly budgetMs?: number; readonly max?: number }): Effect.Effect<SummaryStats>;
  /** Write (or rewrite, with `force`) one story's summary. Returns false when nothing needed writing. */
  write(storyId: number, force?: boolean): Effect.Effect<boolean, SummarizeError>;
}>()("news/pipeline/Summaries") {
  static readonly layer = Layer.effect(
    Summaries,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const summarizer = yield* Summarizer;
      const feed = yield* Feed;
      const embeddings = yield* Embeddings;
      const scan = yield* Ref.make<{ at: number; queue: ReadonlyArray<number> }>({ at: 0, queue: [] });

      const candidates = (storyId: number) =>
        sql<Candidate>`
          select distinct on (a.embed_key) a.embed_key, a.domain, r.name as outlet, a.sitename, a.title, a.lede, left(a.body, 1600) as body,
                 r.bias, r.factuality, e.cvec <=> g.centroid as dist
          from story_texts t
          join stories g on g.id = t.story_id
          join articles a on a.embed_key = t.embed_key and a.reject_reason is null
          join embeddings e on e.embed_key = t.embed_key
          left join lateral resolve_domain(a.domain) r on true
          where t.story_id = ${storyId}
          order by a.embed_key, length(coalesce(a.body, '')) desc`.pipe(Effect.orDie);

      const hashOf = (keys: ReadonlyArray<string>, model: string) =>
        new Bun.CryptoHasher("md5").update(`${PROMPT_VERSION}|${model}|${[...keys].sort().join(",")}`).digest("hex");

      const markFailure = (storyId: number) =>
        sql`
          insert into summary_state (story_id, failures, next_attempt_at)
          values (${storyId}, 1, now() + interval '2 minutes')
          on conflict (story_id) do update set
            failures = summary_state.failures + 1,
            next_attempt_at = now() + make_interval(mins => least(60, power(2, summary_state.failures + 1)::int)),
            requested_at = case when summary_state.failures + 1 >= ${MAX_FAILURES} then null else summary_state.requested_at end`.pipe(Effect.orDie);

      const write = Effect.fn("Summaries.write")(function* (storyId: number, force = false) {
        const cands = yield* candidates(storyId);
        const picked = pickSources(cands);
        if (picked.length === 0) return false;
        const hash = hashOf(picked.map((p) => p.embedKey), summarizer.model);
        const [row] = yield* sql<Existing>`select input_hash, model, version, indep, generated_at from story_summaries where story_id = ${storyId}`.pipe(Effect.orDie);
        const [st] = yield* sql<{ indep: number | null }>`select indep from stories where id = ${storyId}`.pipe(Effect.orDie);
        const indep = st?.indep ?? picked.length;
        if (!force && !shouldRewrite(row ?? null, { hash, model: summarizer.model, indep })) return false;
        if (force && row && row.inputHash === hash && row.version === PROMPT_VERSION && row.model === summarizer.model) {
          yield* sql`update summary_state set requested_at = null where story_id = ${storyId}`.pipe(Effect.orDie); // demand for a summary that is already current
          return false;
        }
        const body = yield* summarizer.summarize(picked.map(toSource)).pipe(Effect.tapError(() => markFailure(storyId)));
        yield* sql`
          insert into story_summaries (story_id, body, input_hash, model, version, indep)
          values (${storyId}, ${body}, ${hash}, ${summarizer.model}, ${PROMPT_VERSION}, ${indep})
          on conflict (story_id) do update set body = excluded.body, input_hash = excluded.input_hash, model = excluded.model,
            version = excluded.version, indep = excluded.indep, generated_at = now()`.pipe(Effect.orDie);
        yield* sql`
          insert into summary_state (story_id) values (${storyId})
          on conflict (story_id) do update set requested_at = null, failures = 0, next_attempt_at = now()`.pipe(Effect.orDie);
        yield* sql`select pg_notify(${SUMMARY_READY}, ${JSON.stringify({ id: storyId })})`.pipe(Effect.ignore);
        return true;
      });

      /** Visible stories without a current summary, most important first; refreshed every couple of minutes. */
      const rescan = Effect.gen(function* () {
        const top = yield* feed.list({ limit: 150, minOutlets: 3, sort: "top", hours: 48 });
        const per = new Map<string, number>();
        const wanted = top.filter((s, i) => {
          const n = per.get(s.topic ?? "") ?? 0;
          per.set(s.topic ?? "", n + 1);
          return i < PRE_TOP || n < PRE_PER_TOPIC;
        });
        const ids = wanted.map((s) => s.id);
        if (ids.length === 0) return [] as number[];
        const have = yield* sql<{ storyId: number; indep: number; model: string; version: number; generatedAt: Date }>`
          select s.story_id, s.indep, s.model, s.version, s.generated_at
          from story_summaries s where s.story_id in ${sql.in(ids)}`.pipe(Effect.orDie);
        const backoff = yield* sql<{ storyId: number }>`select story_id from summary_state where next_attempt_at > now() and story_id in ${sql.in(ids)}`.pipe(Effect.orDie);
        const cooling = new Set(backoff.map((b) => Number(b.storyId)));
        const mine = new Map(have.map((h) => [Number(h.storyId), h]));
        return wanted
          .filter((s) => {
            if (cooling.has(s.id)) return false;
            const h = mine.get(s.id);
            if (!h) return true;
            if (h.version !== PROMPT_VERSION || h.model !== summarizer.model) return true;
            return s.reports >= h.indep + 3 && s.reports >= 1.5 * h.indep && Date.now() - +h.generatedAt >= REWRITE_MIN_AGE_MS;
          })
          .map((s) => s.id);
      });

      const run = Effect.fn("Summaries.run")(function* (opts?: { readonly budgetMs?: number; readonly max?: number }) {
        const t0 = Date.now();
        const budget = opts?.budgetMs ?? TICK_BUDGET_MS;
        const max = opts?.max ?? MAX_PER_TICK;
        const stats = { demand: 0, scheduled: 0, failed: 0, skipped: 0 };
        const attempt = (id: number, force: boolean, kind: "demand" | "scheduled") =>
          write(id, force).pipe(
            Effect.map((wrote) => void (wrote ? stats[kind]++ : stats.skipped++)),
            Effect.catch((e) => Effect.logWarning(`summary for story ${id}: ${e.message}`).pipe(Effect.map(() => void stats.failed++))),
          );
        const left = () => Date.now() - t0 < budget && stats.demand + stats.scheduled + stats.failed < max;

        // 1. A visitor is waiting for these.
        const demand = yield* sql<{ storyId: number }>`
          select story_id from summary_state where requested_at is not null and next_attempt_at <= now() order by requested_at limit ${max}`.pipe(Effect.orDie);
        for (const d of demand) if (left()) yield* attempt(Number(d.storyId), true, "demand");

        // 2. Pre-write what the front page shows, unless embedding is behind (it feeds clustering and shares the GPU).
        const backlog = (yield* embeddings.stats).unembedded;
        if (left() && backlog <= EMBED_BACKLOG_PAUSE) {
          const s = yield* Ref.get(scan);
          let { at, queue } = s;
          if (Date.now() - at >= SCAN_EVERY_MS) {
            queue = yield* rescan;
            at = Date.now();
          }
          while (queue.length > 0 && left()) {
            const [id, ...rest] = queue;
            queue = rest;
            yield* attempt(id!, false, "scheduled");
          }
          yield* Ref.set(scan, { at, queue });
        }
        return stats satisfies SummaryStats;
      });

      return Summaries.of({ run, write });
    }),
  );
}
