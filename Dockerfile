# syntax=docker/dockerfile:1
#
# Three images come out of this file:
#   (no target)     everything in one container: migrations, web server and worker. For
#                   platforms that run one container per service (Railway and similar).
#   --target web    the Next.js standalone server alone (small, no dev tooling)
#   --target tools  the full workspace: runs the worker, the migrations and the seed
# Docker Compose (docker-compose.yml) uses the "web" and "tools" targets.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# ---- dependencies (cached until a manifest or the database schema changes)
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/integrations/package.json packages/integrations/
COPY e2e/package.json e2e/
# The db package generates its client on install, so it needs its schema and config.
COPY packages/db/package.json packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/db/src/env.ts packages/db/src/env.ts
RUN pnpm install --frozen-lockfile

# ---- build
FROM deps AS build
COPY . .
RUN pnpm db:generate && pnpm build

# ---- worker, migrations, seed
# Runs as an unprivileged user and starts the processes with node directly, so nothing needs to
# write inside the workspace at run time.
FROM build AS tools
ENV NODE_ENV=production
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /repo/apps/worker
CMD ["node", "--import", "tsx", "src/index.ts"]

# ---- web server
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN mkdir -p /data/storage && chown -R node:node /data
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/intake/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---- everything in one container (the default when no target is given)
# Brings the database up to date, then runs the web server and the worker side by side; see
# deploy/start.mjs. It starts as root only to hand the attached disk to the "node" user, and
# runs everything as that user.
FROM build AS allinone
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/data/storage
# The standalone server expects its static files next to it.
RUN cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && cp -r apps/web/public apps/web/.next/standalone/apps/web/public \
 && chown -R node:node apps/web/.next \
 && mkdir -p /data/storage && chown -R node:node /data
WORKDIR /repo
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/intake/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "deploy/start.mjs"]
