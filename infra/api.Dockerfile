# API and worker image.
#
# `infra/docker-compose.yml` has referenced this file since it was written and
# it did not exist — the compose stack has never been run, so nothing ever
# reported the missing build context. Found during the Docker bring-up.
#
# One image for both processes. They share every dependency and differ only in
# entrypoint (`dist/main.js` vs `dist/worker.js`), so two images would be two
# things to keep in sync for no benefit.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

# corepack ships with node and pins pnpm to the version in package.json's
# `packageManager` field, so the image cannot drift from what the lockfile was
# resolved with.
RUN corepack enable

WORKDIR /repo

# Manifests first, so a source-only change does not invalidate the dependency
# layer. This is the difference between a 10-second rebuild and a 3-minute one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/

RUN pnpm install --frozen-lockfile --filter @rideapp/api...

COPY tsconfig.base.json* ./
COPY services/api services/api

RUN pnpm --filter @rideapp/api build

# Re-resolve with production dependencies only. `--prod` after the build, not
# before: the build needs typescript and swc, the runtime must not carry them.
RUN pnpm install --frozen-lockfile --prod --filter @rideapp/api...

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production

# `tini` as PID 1. Without an init, node receives SIGTERM as PID 1 and Docker's
# default handling means the graceful-shutdown path (drain connections, release
# distributed locks, close pools) is skipped on every deploy.
RUN apk add --no-cache tini

WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/services/api/node_modules ./services/api/node_modules
COPY --from=build /repo/services/api/dist ./dist
COPY --from=build /repo/services/api/package.json ./package.json

# Migrations are read from disk at runtime by `migrate.ts`, so they are part of
# the image rather than something mounted in.
COPY --from=build /repo/services/api/migrations ./migrations

# node:alpine already provides an unprivileged `node` user. Running as root
# inside a container that terminates internet traffic is a gift to anyone who
# finds an RCE.
USER node

EXPOSE 3000

# Compose overrides this for the worker. Kept here so `docker run` on the image
# alone does something sensible.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
