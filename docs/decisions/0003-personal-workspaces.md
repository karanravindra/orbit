# 0003: One personal workspace per user

**Status:** Accepted

## Context
Every user needs a place to work, and ownership should be unambiguous.

## Decision
Each user gets one personal workspace at sign-up and is its permanent sole
owner. Users cannot create other workspaces and join others by invitation.
Workspaces cannot be deleted, and ownership cannot be transferred, invited, or
removed. Invitations and admin-role grants are limited to owners and admins,
regardless of custom-role permissions.

## Consequences
- No ownership-transfer or orphaned-workspace cases.
- A workspace lasts as long as its owner (`personalOwnerId` cascades).
- Rules are enforced in `personal-organization` and `member-guards` plugins.
