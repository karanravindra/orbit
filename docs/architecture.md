# Architecture

Orbit is a Bun workspace with three parts: an API, a web app, and shared
packages.

```
apps/
  api/       Hono + Better Auth server (Bun or Cloudflare Workers)
  web/       React + Vite single-page app
packages/
  db/        Drizzle schema, migrations, runtime-specific database factories
  tsconfig/  Shared TypeScript configs (base, browser)
```

## API (`apps/api`)

`createApp({ db, env })` in `src/app.ts` builds the Hono app. It takes its
dependencies as arguments, so every entry point and test builds the same app.

| Entry point | Runtime | Database |
| --- | --- | --- |
| `src/index.ts` (via `src/local.ts`) | Bun server with graceful shutdown | SQLite file (`DATABASE_PATH`) |
| `src/worker.ts` | Cloudflare Worker | D1 binding `DB` |
| `src/testing.ts`, `e2e/server.ts` in web | Tests | In-memory SQLite |

Middleware runs in this order: request ID, request logging, secure headers,
CORS, body limit. Then `/api/auth/*` goes to Better Auth and `/health` to the
health routes. Unknown routes and errors return `{ code, message }`.

Config is parsed and validated by `src/lib/env.ts`. Bun validates at startup;
Workers validate on each request, before the app handles it.

### Auth (`src/lib/auth`)

`createAuth` configures Better Auth with the plugins `captcha`,
`haveIBeenPwned`, `emailOTP`, `lastLoginMethod`, `admin`, and `organization`.
Four local plugins in `plugins/` add Orbit's rules on top. Their order matters
because hooks run in plugin order; the comments in `index.ts` explain why.
The rules themselves are in [Auth and access](auth-and-access.md).

### Email (`src/email`)

Templates depend on the `EmailSender` interface (`types.ts`). Adapters:
`console` (dev), `memory` (tests), `resend` (production). Add a provider by
implementing the interface and updating the factory in `index.ts` and
`EMAIL_PROVIDER` in `env.ts`.

## Web (`apps/web`)

React, Vite, Tailwind, and shadcn/ui components on Base UI. Routing is React
Router (`src/app.tsx`); data fetching is TanStack Query. All server calls go
through Better Auth's typed client in `src/lib/auth.ts`; `result()` unwraps
responses and throws on error. Pages live in `src/pages/`, shared UI in
`src/components/`.

The web app does not make its own permission decisions. It reads permissions
from the API and hides actions accordingly; the API enforces them.

## Database (`packages/db`)

Drizzle schema in `src/schema/auth.ts` is **generated** from the Better Auth
configuration. Do not edit it by hand. See [Database](database.md).

`createLocalDb` (Bun SQLite) and `createWorkerDb` (D1) both return a `Db`;
code that needs a database accepts the `Db` union type.

## Request flow

1. Browser calls the API (`/api/auth/*`) with credentials; CORS allows only
   `CORS_ORIGINS`.
2. Hono middleware adds the request ID, headers, and body limit.
3. Better Auth runs its hooks (captcha, local plugin guards), then the
   endpoint, against the database.
4. The response carries `X-Request-Id`. Errors use `{ code, message }`.
