# 0005: One Hono app on Bun and Workers

**Status:** Accepted

## Context
The API must run on Cloudflare Workers and as a long-lived Bun server in Docker.

## Decision
Build the app with `createApp({ db, env })`, taking dependencies as arguments.
Thin entry points (`index.ts`/`local.ts` and `worker.ts`) supply the runtime's
database and parsed environment.

## Consequences
- Tests build the same app with an in-memory database.
- CI exercises both runtimes (Bun tests, local D1 `test:worker`, Docker smoke).
- Code must avoid runtime-specific APIs outside the entry points and `Db`
  factories.
