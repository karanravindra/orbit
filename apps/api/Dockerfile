FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.2
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/orbit.sqlite
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bunfig.toml ./
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/tsconfig ./packages/tsconfig
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
VOLUME /data
WORKDIR /app/apps/api
CMD ["sh", "-c", "bun run ../../packages/db/src/migrate.ts && exec bun run src/index.ts"]
