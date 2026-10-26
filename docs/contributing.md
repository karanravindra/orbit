# Contributing

## Workflow

1. Branch from `main`. There are no long-lived branches besides `main`.
2. Make small, focused changes. CI runs on every PR and deploys a preview
   Worker for same-repository PRs.
3. Before pushing, run `bun run check`, `bun run typecheck`, and
   `bun run test`.
4. Merge through a PR once the `check` job passes.

## Commits

Use atomic commits in [Conventional Commits](https://www.conventionalcommits.org)
format: `type(scope): summary`, for example
`feat(web): replace sidebar workspace nav with user menu`.

- Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scope is the area touched: `api`, `web`, `db`, `tsconfig`.
- One logical change per commit. Keep tests with the code they cover.

## Code style

- Biome formats and lints (tabs, double quotes, organized imports). The
  pre-commit hook runs it; `bun run check` runs it by hand.
- TypeScript everywhere, with shared configs from `packages/tsconfig`.
- Tests live in a `tests/` folder beside the code they cover.
- Comment the *why*, especially around auth rules and plugin ordering.
- Never hand-edit generated files (`packages/db/src/schema/auth.ts`,
  `packages/db/drizzle/`, `packages/db/migrations/`). See [Database](database.md).

## Docs

If a change alters behavior, setup, configuration, endpoints, or a business
rule, update the matching file in `docs/` in the same PR. Record significant
technical decisions as an ADR in [decisions/](decisions/README.md).
