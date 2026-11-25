# Deploying news to the homelab

## Process
1. Merge to `main` (changes under `apps/news`, `packages`, or the lockfile).
2. GitHub Actions (`.github/workflows/news-image.yml`) runs `bun test`, then builds a multi-arch (amd64 + arm64) image and pushes
   `ghcr.io/<owner>/orbit-news` tagged `latest` and `sha-<short>`. Tag `news-vX.Y.Z` to also publish a version tag.
3. On the homelab: `docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d`.
   The one-shot `migrate` service runs first; `worker` and `web` wait for it.
Roll back by setting `NEWS_TAG=sha-<old>` in `.env` and running `up -d` again.

## First-time setup on the homelab
1. Copy `apps/news/compose.prod.yaml` and `apps/news/.env.prod.example` (as `.env`) to a folder on the server; set the passwords.
2. Let the server pull private images: `echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin`
   (a classic PAT with `read:packages`), or make the package public in GitHub's package settings.
3. Run Ollama on the host (or point the `*_BASE_URL` vars elsewhere) and pull the models in `.env`.
4. `docker compose -f compose.prod.yaml run --rm web outlets import` once to load the outlet ratings (re-run after editing the CSVs).
5. `docker compose -f compose.prod.yaml up -d`. The UI is on `WEB_PORT` (default 3000). There is no auth or TLS, so put it behind
   Tailscale or a reverse proxy.

## Notes
- Postgres and Redis are not published to the host; only `web` is.
- Back up with `docker compose exec db pg_dump -U news news > news.sql`.
- Operate with the same image: `docker compose run --rm web status`.
