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

## Deployment, migrations, and Docker

See [Deployment](../../docs/deployment.md) for CI, previews, production,
GitHub and Cloudflare setup, and on-prem Docker. See
[Database](../../docs/database.md) for schema changes and migrations.
