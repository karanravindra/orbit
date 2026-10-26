# Database

Orbit uses SQLite everywhere: a local file under Bun and on-prem Docker, and
Cloudflare D1 on Workers. Both use the same schema and SQL migrations, and both
track applied files in `d1_migrations`.

## Layout

| Path | Contents |
| --- | --- |
| `packages/db/src/schema/auth.ts` | Drizzle schema, **generated** from the Better Auth config. |
| `packages/db/drizzle/` | Drizzle's migration folders and snapshots. |
| `packages/db/migrations/` | Flat SQL copies of those migrations, the layout Wrangler expects. |

Tables: `user`, `session`, `account`, `verification`, `organization`,
`organization_role`, `team`, `team_member`, `member`, `invitation`.

## Changing the schema

After changing Better Auth plugin or schema options:

```sh
bun run --cwd apps/api --env-file=.env.test auth:generate
bun run db:generate
```

Commit all of: `packages/db/src/schema/auth.ts`, the snapshots under
`packages/db/drizzle/`, and the SQL under `packages/db/migrations/`. CI
regenerates both and fails if anything differs or is untracked.

## Safe migrations

CI migrates production D1 *before* uploading the new Worker, and a failed
migration stops the deploy. Redeploying old code does not undo a migration, so
every schema change must work with the code currently running:

1. Add new columns (nullable or defaulted) and ship.
2. Ship code that uses them.
3. Remove old columns in a later release.

Recover production data with Cloudflare D1's recovery tools.

## Local database

`bun run db:migrate` applies migrations to `orbit.sqlite` in the repo root. The
Workers dev database (`.wrangler/`) is separate; use
`bun run --filter @orbit/api db:migrate:worker`.

PostgreSQL is no longer supported. The SQLite migrations initialize a new
database and do not convert existing PostgreSQL data.
