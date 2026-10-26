# orbit

Orbit is a Bun workspace. The API uses Hono, Better Auth, Drizzle, and SQLite.
It runs on Cloudflare Workers with D1, or on-prem with Docker and a SQLite file.

See [docs/](docs/README.md) for architecture, auth rules, development,
deployment, and contributing. [API setup](apps/api/README.md) covers local
development with Bun and Workers.

```sh
bun install
bun run check
bun run typecheck
bun run test
```
