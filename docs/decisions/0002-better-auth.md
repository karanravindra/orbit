# 0002: Better Auth for identity and organizations

**Status:** Accepted

## Context
Orbit needs accounts, sessions, organizations, teams, custom roles, and
platform admin tooling.

## Decision
Use Better Auth with its `organization` (teams and dynamic access control) and
`admin` plugins, plus small local plugins for Orbit-specific rules. The auth
schema is generated from the config.

## Consequences
- The web app uses Better Auth's typed client directly; the API has few
  custom routes.
- Schema changes follow the generate-then-migrate flow, and CI enforces it.
- Orbit's rules are guard hooks around Better Auth, so plugin order matters.
