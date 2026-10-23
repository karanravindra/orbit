# Orbit web

React, Vite, TypeScript, and official shadcn/ui components built on Base UI.
The app uses Better Auth’s typed client to connect to `apps/api`.

## Run locally

From the repository root:

```sh
bun install
bun run --filter @orbit/api db:migrate
bun run --filter @orbit/api dev
```

Configure the API first using [its setup guide](../api/README.md).
In another terminal, start the frontend:

```sh
bun run --filter @orbit/web dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://localhost:3000`.
Development defaults to Cloudflare’s always-pass Turnstile site key. With
the API’s console email provider, verification and reset codes appear in API logs.

## Configuration

Copy `.env.example` to `.env` inside `apps/web` to override defaults:

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | API origin. Omit it to use the web app’s origin and route `/api` to the API. |
| `VITE_TURNSTILE_SITE_KEY` | Public Turnstile site key. Required for production builds. |

Vite embeds these values at build time. API secrets belong only in the API environment.
Set the API’s `APP_URL` to the web app’s public URL so invitation links work.
Include the web app’s origin in the API’s `CORS_ORIGINS`.

For production, serve the frontend and API on the same site, such as
`app.example.com` and `api.example.com`, or proxy `/api` through the frontend origin.
Session cookies use the API’s existing cookie settings.

## Screens

- Sign-up, sign-in, email verification, code resend, and password reset.
- Workspace overview, workspace switching, and workspace settings.
- Paginated members, multiple member roles, removal, and leaving invited workspaces.
- Sending, resending, cancelling, accepting, and declining invitations.
- Team creation, renaming, deletion, membership management, and active-team selection.
- Custom roles with individual resource permissions.
- Profile, password changes, and active-session management.
- Platform-admin user creation, editing, roles, bans, password setting,
  session revocation, deletion, and impersonation.

Permission checks come from the API, including custom-role permissions.
Ownership protections remain enforced by the API. Invitation links preserve
their destination through sign-in, sign-up, and email verification.

## Build and test

```sh
bun run --filter @orbit/web build
bun run --filter @orbit/web typecheck
bun run --filter @orbit/web test:install
bun run --filter @orbit/web test
```

The production build is written to `apps/web/dist`. Deploy it to a static host
with a fallback to `index.html` for client-side routes, including
`/accept-invitation`. Configure the API reverse proxy before the fallback
when using the same origin.

Browser tests start an isolated API on `127.0.0.1:3100` with in-memory SQLite,
and Vite on `127.0.0.1:5174`. They use the real API auth and organization flows,
with deterministic Turnstile and password-breach service substitutes.
The test-only server is separate from both production entry points.
