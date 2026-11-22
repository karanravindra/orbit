---
name: commit
description: Create atomic, Conventional Commits from the working tree. Use when the user asks to commit, save changes, or split work into commits.
---

# Commit

Turn the current working-tree changes into a series of atomic commits that follow [Conventional Commits](https://www.conventionalcommits.org/).

## Process

1. **Inspect**: run `git status --short`, `git diff`, and `git diff --staged`. Also run `git log --oneline -10` to match existing scope naming.
2. **Group**: split changes into logical units. Each commit must be one self-contained change that builds and typechecks on its own. Never mix unrelated concerns (e.g. a feature plus a refactor plus a dependency bump).
3. **Stage precisely**: stage only the files (or hunks, via `git add -p`) for the current commit. Never use `git add -A` or `git add .` blindly. Unstage anything left over from earlier with `git restore --staged`.
4. **Commit**: one commit per group, in dependency order (e.g. config/infrastructure before the code that uses it).
5. **Verify**: finish with `git log --oneline` and `git status` to confirm the tree is clean, or report what was intentionally left uncommitted.

## Message format

```
<type>(<scope>): <description>

<optional body>

<optional footer>
```

- **type**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **scope**: optional; the package or area touched (e.g. `tsconfig`, `api`). Reuse scopes already present in history.
- **description**: imperative mood, lowercase, no trailing period, 72 characters or fewer ("add x", not "added x").
- **body**: only when the *why* isn't obvious from the diff. Wrap at 72 characters.
- **breaking changes**: add `!` after the type/scope (`feat(api)!: ...`) and a `BREAKING CHANGE: ...` footer.
- Pass messages with multiple `-m` flags or a heredoc so formatting is preserved.

## Rules

- Do not commit secrets (`.env`, credentials, keys). Warn the user if asked to.
- Do not commit generated or ignored files (`node_modules`, `dist`, `*.tsbuildinfo`).
- Do not amend, rebase, force-push, or push unless the user explicitly asks.
- Never skip hooks (`--no-verify`). If a hook fails, fix the cause and create a new commit.
- If the changes can't be cleanly separated, or intent is ambiguous, ask before committing.
- If there's nothing to commit, say so and stop.
