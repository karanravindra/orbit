# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/news/Dockerfile .
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY apps/news/package.json apps/news/
# holykhao is a workspace member, so its manifest must exist for a frozen lockfile; --filter keeps its deps out.
COPY apps/holykhao/package.json apps/holykhao/
RUN bun install --frozen-lockfile --production --filter @orbit/news

FROM oven/bun:1.4.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/news/node_modules ./apps/news/node_modules
COPY package.json tsconfig.json ./
COPY packages/tsconfig packages/tsconfig
COPY apps/news/package.json apps/news/tsconfig.json apps/news/
COPY apps/news/src apps/news/src
COPY apps/news/data apps/news/data
# Relative paths (data/outlets.csv) resolve from here.
WORKDIR /app/apps/news
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD bun -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["bun", "src/main.ts"]
CMD ["serve"]
