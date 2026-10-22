# API setup and deployments

The API runs on Cloudflare Workers with D1 or on Bun with a local SQLite file.
Both runtimes use the same auth configuration, schema, and SQL migrations.

## Local development with Bun

Install Bun 1.4.2. Run these commands from the repository root:

```sh
bun install
cp apps/api/.env.example apps/api/.env
openssl rand -base64 32
```

Put the generated value in `BETTER_AUTH_SECRET` in `apps/api/.env`.
Then migrate the database and start the server:

```sh
bun run --filter @orbit/api db:migrate
bun run --filter @orbit/api dev
```

The API listens on `http://localhost:3000`. The default database is
`orbit.sqlite` in the repository root. `DATABASE_PATH` is relative to the
working directory; workspace scripts run from their package directories.
Set an absolute path when overriding it.

Development uses Cloudflare's Turnstile test secret and logs emails to the
console. The frontend must use a Turnstile test site key and send its token in
`x-captcha-response`. Verification codes appear in the API logs.

## Local development with Workers

Run these commands from the repository root:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
bun run --filter @orbit/api db:migrate:worker
bun run --filter @orbit/api dev:worker
```

Set a random `BETTER_AUTH_SECRET` in `.dev.vars`. Wrangler runs the API on
`http://localhost:8787` with a local D1 database under `.wrangler/`.
This database is separate from the Bun development database.
The placeholder database ID in `wrangler.jsonc` is for local use. CI generates
the real binding configuration when deploying.

## API endpoints and runtime configuration

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness, independent of the database. |
| `GET /health/ready` | Readiness; returns 503 if the database or user table is unavailable. |
| `/api/auth/*` | Existing Better Auth routes and organization/admin plugins. |

Responses include security headers and `X-Request-Id`. Request logs contain
the method, path, status, request ID, and duration. They omit query strings
and request bodies. Unknown routes and application errors use `{ code, message }`.
`MAX_BODY_BYTES` defaults to 1 MiB. Bun shuts down within
`SHUTDOWN_TIMEOUT_MS`, which defaults to 10 seconds.

Configuration is validated at startup in Bun and before request handling in
Workers. Production requires HTTPS public URLs, a real Turnstile secret,
and a delivering email provider. `EMAIL_PROVIDER=resend` requires
`RESEND_API_KEY` and a verified `EMAIL_FROM` sender.

Email templates depend on the `EmailSender` interface in `src/email/types.ts`.
The console, memory, and Resend adapters implement that interface. Add another
provider by implementing it and updating the sender factory and environment schema.

## Branch and release model

| Event | Result |
| --- | --- |
| Same-repository PR opened or updated | Checks run, then CI creates or updates a Worker and dedicated D1 database. |
| PR closed or merged | CI deletes that PR's Worker and D1 database. |
| Push to `main` | Checks run, then CI migrates production D1 and deploys the Worker. |
| Push a `v1.2.3` tag | Checks run, then CI publishes Docker images for amd64 and arm64. |

Feature branches merge into `main` through PRs. There is no long-lived
`develop` branch. Fork PRs run checks without receiving deployment credentials.
Cloudflare production and previews deploy through `.github/workflows/ci.yml`.
Cleanup runs through `.github/workflows/preview-cleanup.yml`.

The default production Worker and database are named `orbit-api`.
Preview resources are named `orbit-api-pr-<number>`.
Each preview keeps its database across updates until the PR closes.
Preview auth secrets are derived from the preview environment's secret and PR
number. Previews use test Turnstile credentials and console email delivery.
They never use the production database or Resend credentials.
The workflow summary contains the deployed API URL.

## Configure GitHub and Cloudflare

Create GitHub environments named `preview` and `production`. Leave production
without required reviewers to keep main deployments automatic.

Configure these values in each environment:

| Name | Type | Required in |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Both |
| `CLOUDFLARE_API_TOKEN` | Secret | Both |
| `BETTER_AUTH_SECRET` | Secret, at least 32 random characters; use different values per environment | Both |
| `APP_URL` | Variable, frontend URL | Both |
| `CORS_ORIGINS` | Optional variable, comma-separated frontend origins; defaults to the origin of `APP_URL` | Both |
| `WORKER_NAME` | Optional variable, defaults to `orbit-api`; keep the same prefix in both environments | Both |
| `API_URL` | Optional variable, HTTPS custom domain URL; otherwise uses workers.dev | Production |
| `TURNSTILE_SECRET_KEY` | Secret | Production |
| `RESEND_API_KEY` | Secret | Production |
| `EMAIL_FROM` | Variable, verified Resend sender | Production |
| `ADMIN_EMAILS` | Optional variable, comma-separated platform admin emails | Production |

Set up a Workers subdomain in Cloudflare before the first deployment.
Give the API token account permissions for Workers Scripts and D1 editing,
and Workers subdomain access. A custom domain also needs the corresponding
zone permissions for Workers routes. The production script creates the D1
database on its first run and reuses it afterward.

Enable GitHub Actions package publishing for GHCR (GitHub Container Registry).
The workflow uses `GITHUB_TOKEN` to publish images; no registry password is needed.
Protect `main` with the `check` job as a required status check.

For a manual retry from a configured shell, run:

```sh
bun run apps/api/scripts/cloudflare.ts production
# Preview deploy or cleanup also requires PR_NUMBER.
bun run apps/api/scripts/cloudflare.ts preview
bun run apps/api/scripts/cloudflare.ts cleanup
```

Supply the same environment variables and secrets listed above.
Cleanup permanently deletes the selected preview database. It cannot target
production because it always requires and appends a PR number.

## Schema and migrations

The schema is generated from Better Auth configuration. After changing auth
schema settings, regenerate it and create a migration:

```sh
bun run --cwd apps/api --env-file=.env.test auth:generate
bun run db:generate
```

Commit `packages/db/src/schema/auth.ts`, the snapshots under
`packages/db/drizzle/`, and the flat SQL files under `packages/db/migrations/`.
The export script copies Drizzle's SQL into the flat layout Wrangler expects.
Both runtimes track applied files in `d1_migrations`.

CI applies D1 migrations before uploading the new Worker. A migration failure
stops deployment. Schema changes must remain compatible with the currently
running version. Add new columns first, deploy code that uses them, and remove
old columns in a later release. Redeploying older code does not undo migrations.
Use Cloudflare D1 recovery tools for database recovery.

PostgreSQL is no longer supported. The SQLite migrations initialize a new
database; they do not convert existing PostgreSQL data.

## On-prem Docker

Use the production environment example:

```sh
cp apps/api/.env.production.example apps/api/.env
```

Fill in the public HTTPS URLs, auth secret, Turnstile secret, and Resend
configuration. Run a TLS reverse proxy in front of port 3000.
Build locally with `docker compose up --build -d`.

To use a published release instead:

```sh
export ORBIT_API_IMAGE=ghcr.io/karanravindra/orbit-api:1.2.3
docker compose pull api
docker compose up -d --no-build api
```

Images are published as `ghcr.io/<owner>/<repository>-api:<version>`.
Stable releases also update `latest`; prerelease tags do not.
Release tags must point to a commit on `main`.
Operators choose when to pull a version and restart the service.

The container runs as the `bun` user. It applies pending migrations before
starting the API and stores SQLite data in the `api-data` volume at `/data`.
An invalid migration prevents the server from starting.
Use one API replica per SQLite file. Keep the volume across upgrades.
For a consistent file backup, stop the service before copying its database files.
Back up before upgrading; reverting the image does not revert its migrations.

## Checks

```sh
bun run check
bun run typecheck
bun run test
bun run --filter @orbit/api worker:check
bun run --cwd apps/api test:worker
```

Bun tests migrate an in-memory SQLite database and stub the external captcha
and password-breach services. The Workers integration check uses an isolated
local D1 database. It verifies migrations, readiness, sign-in, session lookup,
and personal organization creation. CI also builds and starts the Docker image.
