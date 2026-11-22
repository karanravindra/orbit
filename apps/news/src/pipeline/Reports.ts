import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { independentReports } from "../cluster/wire";

const RECENT_DAYS = 14;
const BATCH = 40;

export interface ReportStats {
  readonly stories: number;
  readonly changed: number;
}

/**
 * Counts independent reports per story: texts whose ledes share long runs of words are copies of one wire story.
 * Stored on `stories.indep` (with the size it was computed at) so the feed reads it for free; a story is recomputed
 * whenever its size differs, which for a quiet story is never.
 */
export class Reports extends Context.Service<Reports, {
  run(opts?: { readonly all?: boolean }): Effect.Effect<ReportStats>;
}>()("news/pipeline/Reports") {
  static readonly layer = Layer.effect(
    Reports,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const run = Effect.fn("Reports.run")(function* (opts?: { readonly all?: boolean }) {
        const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
        const todo = yield* sql<{ id: number; texts: number }>`
          select g.id, (select count(*)::int from story_texts t where t.story_id = g.id) as texts
          from stories g
          where g.last_seen >= ${since}
            and (${opts?.all ?? false} or g.indep_texts is distinct from (select count(*)::int from story_texts t where t.story_id = g.id))`;
        let changed = 0;
        for (let i = 0; i < todo.length; i += BATCH) {
          const batch = todo.slice(i, i + BATCH);
          const ids = batch.map((t) => Number(t.id));
          const rows = yield* sql<{ storyId: number; text: string }>`
            select t.story_id, coalesce(nullif(a.lede, ''), a.title, '') as text
            from story_texts t
            join lateral (select a.lede, a.title from articles a where a.embed_key = t.embed_key and a.reject_reason is null order by a.id limit 1) a on true
            where t.story_id in ${sql.in(ids)}
            order by t.story_id, t.assigned_at, t.embed_key`;
          const byStory = new Map<number, string[]>();
          for (const r of rows) (byStory.get(Number(r.storyId)) ?? byStory.set(Number(r.storyId), []).get(Number(r.storyId))!).push(r.text);
          // indep_texts records the story size used as the staleness marker (story_texts rows), not the loaded count.
          const out = batch.map((t) => ({ id: Number(t.id), indep: independentReports(byStory.get(Number(t.id)) ?? []), texts: t.texts }));
          yield* sql`
            update stories g set indep = v.indep, indep_texts = v.texts
            from json_to_recordset(${JSON.stringify(out)}::json) as v(id bigint, indep int, texts int)
            where g.id = v.id`;
          changed += out.length;
        }
        return { stories: todo.length, changed } satisfies ReportStats;
      }, Effect.orDie);

      return Reports.of({ run });
    }),
  );
}
