# Auth and access

These are Orbit's business rules. They are enforced by the API; the web app
only reflects them. Code lives in `apps/api/src/lib/auth/`.

## Accounts and sign-up

- Sign-up is email and password. Email verification is required before sign-in.
- Passwords are checked against Have I Been Pwned.
- Sign-up, sign-in, and the endpoints that send verification or reset codes
  require a Cloudflare Turnstile token in the `x-captcha-response` header.
- Verification and password reset use a one-time **code** emailed to the user,
  not a link. Codes expire after 5 minutes and are stored hashed.
- Code-based sign-in, sign-up from a code, and the link-based verify and reset
  endpoints are disabled.
- Verifying an email signs the user in. Codes are only sent to, and only
  accepted for, unverified accounts, so they can never act as passwordless
  sign-in. Requests for an already-verified address look like a normal send.
- A password reset signs the user out everywhere.

### Signing up with an unverified address

If someone signs up with an email that exists but is unverified, nobody has
proven they own it. The old password is deleted and a fresh code is sent. The
inbox owner verifies, is signed in, and sets a password via reset. Whoever
first claimed the address without verifying is locked out.

## Workspaces (organizations)

The UI says "workspace"; the API and schema say "organization".

- Every user gets exactly one **personal workspace** at sign-up, named
  `<name>'s workspace`. It is created with the user, or on first sign-in if
  that failed. Every new session starts in it.
- Users cannot create more workspaces. They join others only by invitation.
- Workspaces cannot be deleted. A personal workspace lives and dies with its
  user.
- The personal owner is the only owner, always. Ownership cannot be given,
  invited, assigned, changed, or removed, and the owner cannot leave their
  personal workspace.

## Roles and permissions

Built-in roles: `owner`, `admin`, `member`. Workspace admins can also create
**custom roles** from the Roles page, granting individual permissions:

| Resource | Actions |
| --- | --- |
| `organization` | `update`, `delete` |
| `member` | `create`, `update`, `delete` |
| `invitation` | `create`, `cancel` |
| `team` | `create`, `update`, `delete` |
| `ac` (roles) | `create`, `read`, `update`, `delete` |

A member can hold several roles. Two rules hold whatever permissions a custom
role has:

- Only owners and admins can invite members.
- Only owners and admins can give someone the `admin` role.

This stops a custom role with `member:update` from promoting itself into an
admin.

## Invitations

- Sent by email with a link to `/accept-invitation?id=...`; valid 48 hours.
- Can be resent, cancelled, accepted, or declined.
- The link survives sign-in, sign-up, and email verification, so invitees land
  on it afterwards.
- Invitations cannot grant the owner role.

## Teams

Workspaces can have teams. Members can be added and removed, and each user can
select an active team. Team actions follow the `team` permissions above.

## Platform admins

Platform admins (the `admin` user role, separate from workspace roles) manage
all users from `/admin`: create, edit, set roles, ban, set passwords, revoke
sessions, delete, and impersonate (sessions last 1 hour).

Users become platform admins only through `ADMIN_EMAILS`, a comma-separated
allowlist. The role is granted **when the email is verified**, never at
sign-up, so nobody can claim an admin address by registering it first. A
revoked admin is not re-granted on later sign-ins.
