# 0004: Email codes instead of links

**Status:** Accepted

## Context
Verification and password reset need an email proof of ownership.

## Decision
Use short-lived (5 minute), hashed one-time codes. Link flows and code sign-in
are disabled. Codes only work for unverified accounts. Re-signing up with an
unverified address drops the unproven password.

## Consequences
- Codes can't act as passwordless sign-in or let a squatter hold an address.
- Verifying signs the user in, so the guards in `email-verification` must stay.
- Platform admin is granted on verification, never on sign-up.
