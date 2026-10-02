# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm prisma generate && pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache openssl tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
# Migrations on boot are convenient for a single instance (needs the owner URL in
# DIRECT_DATABASE_URL). For least privilege, set MIGRATE_ON_BOOT=false and run
# `prisma migrate deploy` + `pnpm db:roles` as a separate release step, so the running API only
# ever holds the row-level app role credentials (see docs/DATABASE.md).
ENV MIGRATE_ON_BOOT=true
CMD ["sh", "-c", "if [ \"$MIGRATE_ON_BOOT\" = \"true\" ]; then node node_modules/prisma/build/index.js migrate deploy || exit 1; fi; exec node dist/server.js"]
