# syntax=docker/dockerfile:1
#
# The self-host arena server image (deploy/host/README.md). Build it from the repository root:
#   docker build -f deploy/host/Dockerfile .
# (docker-compose.yml does this for `docker compose up --build`). Deploy/host/Dockerfile.dockerignore allowlists what
# the build may see: manifests, the lockfile, the server/SDK/CLI sources and the pinned Arc deployments -- never a
# local stack's directory (.arena-testnet/, .arena-dev/), a wallet or any other file of this checkout.
#
# Stage 1 bundles the server with esbuild (`pnpm build:server`, as `pnpm build:cli` bundles the CLI): one
# zero-dependency file, no node_modules, no tsx at run time. Stage 2 is the Node base image plus that file and its
# assets: no package manager runs in it, and no RUN step at all, so a multi-arch build needs no emulation.

# node 24.22.2 on Alpine 3.24, pinned by its multi-arch index digest.
ARG NODE_IMAGE=node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
# The version packageManager names in package.json; npm checks the tarball against the registry's integrity hash.
RUN npm install --global pnpm@12.6.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY tests/system/package.json tests/system/
COPY tools/vectors/package.json tools/vectors/
# Exactly the lockfile's versions; only what the server and the build script need.
RUN pnpm install --frozen-lockfile --filter agent-arena --filter "@arena/server..."
COPY apps/server/src apps/server/src
COPY packages/sdk/src packages/sdk/src
COPY packages/cli/src packages/cli/src
COPY scripts/build-server.ts scripts/bundle-licenses.ts scripts/
COPY contracts/deployments contracts/deployments
# The npm package name the image advertises (release-cli.yml publishes the CLI under it).
ARG ARENA_CLI_PACKAGE=arc-chess
RUN ARENA_CLI_PACKAGE="$ARENA_CLI_PACKAGE" pnpm build:server --out /out/app \
 && mkdir -p /out/data

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="arc-chess-server" \
      org.opencontainers.image.description="Agent Chess Arena host server (self-host): lobby, relay and indexer. Holds no keys and no funds." \
      org.opencontainers.image.source="https://github.com/levduc/arc-chess" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# The bundle and its assets belong to root and are read-only to the server's user; only /data (SQLite) is its own.
COPY --from=build /out/app/ /app/
COPY --from=build --chown=node:node /out/data/ /data/
USER node
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/arena-host.mjs"]
