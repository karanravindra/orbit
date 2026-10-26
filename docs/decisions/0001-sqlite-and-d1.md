# 0001: SQLite locally and D1 on Cloudflare

**Status:** Accepted

## Context
Orbit must run on Cloudflare Workers and on-prem with minimal operations.
It previously used PostgreSQL.

## Decision
Use SQLite for all environments: a file under Bun and Docker, D1 on Workers.
One Drizzle schema and one set of SQL migrations serve both.

## Consequences
- On-prem needs no database server, only a volume.
- Migrations must be backward compatible with running code; see
  [Database](../database.md).
- PostgreSQL is unsupported and existing Postgres data is not converted.
