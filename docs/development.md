# Development

## Prerequisites

Bun 1.4.2. Docker is only needed to test the container build. Playwright
browsers are installed with `bun run --filter @orbit/web test:install`.

## First run

From the repository root:

```sh
bun install
cp apps/api/.env.example apps/api/.env   # set BETTER_AUTH_SECRET
bun run --filter @orbit/api db:migrate
bun run --filter @orbit/api dev          # API on :3000
bun run --filter @orbit/web dev          # web on :5173, proxies /api
```

Generate the secret with `openssl rand -base64 32`. Dev uses Cloudflare's
always-pass Turnstile keys and logs emails to the API console, so verification
and reset codes appear in the API logs.

To run the Workers runtime locally instead, see "Local development with
Workers" in [apps/api/README.md](../apps/api/README.md).

## Scripts

| Command | What it does |
| --- | --- |
| `bun run check` | Biome lint and format check (also the pre-commit hook). |
| `bun run typecheck` | `tsc --noEmit` in every workspace. |
| `bun run test` | Tests in every workspace. |
| `bun run db:generate` | Create a migration from schema changes. |
| `bun run db:migrate` | Apply migrations to the local SQLite file. |
| `bun run --filter @orbit/api test:worker` | Exercise D1 migrations and auth under Wrangler. |
| `bun run --filter @orbit/web build` | Production web build into `apps/web/dist`. |

## Configuration

API variables are validated in `apps/api/src/lib/env.ts` (the source of truth).

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Unset means production, which enforces real secrets. Set `development` locally. |
| `PORT` | `3000` | Bun only. |
| `DATABASE_PATH` | `../../orbit.sqlite` | Relative to the working directory; use an absolute path when overriding. |
| `BETTER_AUTH_SECRET` | none | Required, 32+ characters. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public API URL. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated web origins. |
| `APP_URL` | `http://localhost:5173` | Web URL, used in email links. |
| `ADMIN_EMAILS` | empty | Platform admin allowlist; see [Auth and access](auth-and-access.md). |
| `TURNSTILE_SECRET_KEY` | none | Required. Test secrets are rejected in production. |
| `EMAIL_PROVIDER` | `console` | `console`, `memory`, or `resend`. Only `resend` is allowed in production. |
| `EMAIL_FROM` | `Orbit <noreply@localhost>` | Must be a verified sender with Resend. |
| `RESEND_API_KEY` | none | Required with `resend`. |
| `MAX_BODY_BYTES` | `1048576` | Request body limit. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Bun graceful shutdown. |

Web variables (`apps/web/.env`, embedded at build time): `VITE_API_URL` and
`VITE_TURNSTILE_SITE_KEY` (required for production builds). Never put secrets
in web variables.

## Testing

- **API unit and integration:** `bun test` in `apps/api`. Tests sit in a
  `tests/` folder next to the code they cover. Helpers are in `src/test-utils`.
- **Worker:** `test:worker` runs migrations and auth against local D1 so the
  Workers runtime stays in parity with Bun.
- **Browser (Playwright):** `apps/web/e2e`. Starts an isolated API on
  `127.0.0.1:3100` with in-memory SQLite and Vite on `5174`, with Turnstile and
  password-breach checks replaced by deterministic fakes. The test-only server
  is separate from both production entry points.

CI runs everything above plus a Docker smoke test; see
[Deployment](deployment.md).

## Git hooks

Lefthook runs `bun run check` before each commit.
