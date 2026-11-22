import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { PgLive } from "../src/db/Db";

/** True when the local Postgres is reachable; DB tests skip themselves otherwise. */
export const dbUp: boolean = await Effect.runPromise(
  SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`select 1`), Effect.timeout("2 seconds"), Effect.provide(PgLive), Effect.as(true), Effect.catch(() => Effect.succeed(false))),
);

class Rollback {
  constructor(readonly value: unknown) {}
}

/** Run `body` inside one transaction that is always rolled back, so DB tests leave no rows behind. */
export const rolledBack = <A, R>(layer: Layer.Layer<R, never, SqlClient.SqlClient>, body: Effect.Effect<A, never, R | SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(body.pipe(Effect.flatMap((a) => Effect.fail(new Rollback(a))))).pipe(
        Effect.catch((e) => (e instanceof Rollback ? Effect.succeed(e.value as A) : Effect.die(e))),
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(PgLive)))) as Effect.Effect<A>,
  );
