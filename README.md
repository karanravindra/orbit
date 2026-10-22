# orbit

Orbit is a Bun workspace. The API uses Hono, Better Auth, Drizzle, and SQLite.
It runs on Cloudflare Workers with D1, or on-prem with Docker and a SQLite file.

See [API setup and deployments](apps/api/README.md) for local development,
GitHub configuration, PR previews, production deploys, and Docker releases.

```sh
bun install
bun run check
bun run typecheck
bun run test
```
