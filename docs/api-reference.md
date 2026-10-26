# API reference

Base URL: `http://localhost:3000` locally. All responses include
`X-Request-Id`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Does not touch the database. |
| `GET /health/ready` | Readiness. Returns 503 if the database or user table is unavailable. |
| `GET, POST /api/auth/*` | Better Auth: sessions, organizations, teams, roles, admin. |

Use the typed client in `apps/web/src/lib/auth.ts` rather than calling auth
routes by hand. Better Auth documents the full route list.

## Auth routes in use

| Area | Notes |
| --- | --- |
| Email and password | `/sign-up/email`, `/sign-in/email`. Require `x-captcha-response`. |
| Email codes | `/email-otp/send-verification-otp`, `/email-otp/verify-email`, `/email-otp/request-password-reset`. |
| Organization | Members, invitations, teams, and custom roles under `/organization/*`. |
| Admin | User management and impersonation under `/admin/*`; platform admins only. |

### Disabled routes

`/sign-in/email-otp`, `/forget-password/email-otp`, `/send-verification-email`,
`/verify-email`, `/request-password-reset`, `/reset-password`. Verification and
reset use codes only.

### Captcha-protected routes

`/sign-up/email`, `/sign-in/email`, `/email-otp/send-verification-otp`,
`/email-otp/request-password-reset`.

## Errors

Every error is `{ "code": string, "message": string }`.

- App-level errors use the HTTP status name: `NOT_FOUND`, `PAYLOAD_TOO_LARGE`,
  `INTERNAL_SERVER_ERROR`.
- Orbit's auth rules add codes such as `CANNOT_LEAVE_PERSONAL_ORGANIZATION`,
  `CANNOT_ADD_OWNER`, `CANNOT_REMOVE_OWNER`, `ONLY_OWNERS_AND_ADMINS_CAN_INVITE`,
  and `OTP_SIGN_IN_DISABLED`. The full list is in
  `apps/api/src/lib/auth/errors.ts`.

## Limits and headers

- Request bodies over `MAX_BODY_BYTES` (1 MiB) get `413`.
- Secure headers are set on every response.
- Credentialed CORS is allowed only for `CORS_ORIGINS`.
- Request logs are JSON lines with method, path, status, request ID, and
  duration. Query strings and bodies are never logged.
