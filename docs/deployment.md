# Deployment

Orbit ships two ways from the same code: Cloudflare Workers with D1, or an
on-prem Docker container with a SQLite file. CI is
`.github/workflows/ci.yml`; preview cleanup is
`.github/workflows/preview-cleanup.yml`.

## Branch and release model

| Event | Result |
| --- | --- |
| Same-repository PR opened or updated | Checks run, then CI creates or updates a Worker and dedicated D1 database. |
| PR closed or merged | CI deletes that PR's Worker and D1 database. |
| Push to `main` | Checks run, then CI migrates production D1 and deploys the Worker. |
| Push a `v1.2.3` tag | Checks run, then CI publishes Docker images for amd64 and arm64. |

Feature branches merge into `main` through PRs; there is no `develop` branch.
Fork PRs run checks but get no deployment credentials. Release tags must be
`vMAJOR.MINOR.PATCH[-prerelease]` and point to a commit on `main`.

## What CI checks

Lint, typecheck, generated schema and migrations are up to date, unit and
browser tests, web build, Worker dry-run build, local D1 migration and auth
test, and a Docker build with a migration and `/health/ready` smoke test.

## Cloudflare

Preview resources are named `orbit-api-pr-<number>`, production
`orbit-api` (override with `WORKER_NAME`). Each preview keeps its database
across updates until the PR closes. Previews use test Turnstile credentials and
console email, derive their auth secret from the environment secret and PR
number, and never touch production data.

### One-time setup

1. Create GitHub environments `preview` and `production`. Leave production
   without required reviewers to keep `main` deploys automatic.
2. Set up a Workers subdomain in Cloudflare.
3. Create an API token with Workers Scripts and D1 edit and Workers subdomain
   access. A custom domain also needs zone permissions for Workers routes.
4. Enable GitHub Actions package publishing for GHCR.
5. Protect `main` with the `check` job as a required status check.

### Environment values

| Name | Type | Required in |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Both |
| `CLOUDFLARE_API_TOKEN` | Secret | Both |
| `BETTER_AUTH_SECRET` | Secret, 32+ random characters, different per environment | Both |
| `APP_URL` | Variable, frontend URL | Both |
| `CORS_ORIGINS` | Optional variable, defaults to the origin of `APP_URL` | Both |
| `WORKER_NAME` | Optional variable, default `orbit-api`; same prefix in both | Both |
| `API_URL` | Optional variable, HTTPS custom domain; otherwise workers.dev | Production |
| `TURNSTILE_SECRET_KEY` | Secret | Production |
| `RESEND_API_KEY` | Secret | Production |
| `EMAIL_FROM` | Variable, verified Resend sender | Production |
| `ADMIN_EMAILS` | Optional variable, platform admin emails | Production |

The production script creates the D1 database on its first run and reuses it.

### Manual retry

With the same variables and secrets in your shell:

```sh
bun run apps/api/scripts/cloudflare.ts production
bun run apps/api/scripts/cloudflare.ts preview   # also needs PR_NUMBER
bun run apps/api/scripts/cloudflare.ts cleanup   # deletes that PR's database
```

Cleanup cannot target production: it always requires a PR number.

## On-prem Docker

```sh
cp apps/api/.env.production.example apps/api/.env
```

Fill in public HTTPS URLs, the auth secret, the Turnstile secret, and Resend
settings. Put a TLS reverse proxy in front of port 3000.

```sh
docker compose up --build -d          # build locally
# or use a published release:
export ORBIT_API_IMAGE=ghcr.io/karanravindra/orbit-api:1.2.3
docker compose pull api && docker compose up -d --no-build api
```

Images are `ghcr.io/<owner>/<repository>-api:<version>`. Stable releases also
update `latest`; prereleases do not. Operators choose when to pull a version.

## Web app

`bun run --filter @orbit/web build` writes `apps/web/dist`. Host it on any
static host with a fallback to `index.html` (client routes include
`/accept-invitation`). Serve it on the same site as the API, or proxy `/api`
through the web origin, so session cookies work. Set `VITE_TURNSTILE_SITE_KEY`
at build time, and set the API's `APP_URL` and `CORS_ORIGINS` to the web
origin.
