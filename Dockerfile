# syntax=docker/dockerfile:1

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

# Dependency layer (cached until a manifest changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/
COPY packages/cli/package.json packages/cli/
COPY packages/shared/package.json packages/shared/
# Scripts are skipped: the container needs no native modules (Postgres only).
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build:shared && pnpm build:dashboard && pnpm build:hub

# ── runtime ──────────────────────────────────────────────────────────────────
# Distroless: no shell, no package manager, runs as non-root.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /app/dist-hub ./dist-hub
COPY --from=build --chown=nonroot:nonroot /app/dashboard/dist ./dashboard/dist

EXPOSE 3847
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch((process.env.ENVVAULT_TLS_CERT?'https':'http')+'://127.0.0.1:3847/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The entrypoint is `node`; bind to all interfaces inside the container.
CMD ["dist-hub/index.js", "serve", "--host", "0.0.0.0"]
