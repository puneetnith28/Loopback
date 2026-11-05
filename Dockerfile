# Loopback gatekeeper image. Multi-stage: build with dev dependencies, run with
# production dependencies only, as the unprivileged `node` user.
FROM node:22.23.3-bookworm-slim AS build
# Toolchain for the better-sqlite3 native module; build stage only, never in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY apps/switch-gate/package.json apps/switch-gate/tsconfig.json apps/switch-gate/
RUN npm ci --no-audit --no-fund
COPY packages/contracts/src packages/contracts/src
COPY apps/switch-gate/src apps/switch-gate/src
RUN npx tsc -b apps/switch-gate && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DB_PATH=/data/loopback.db \
    HTTP_PORT=8787
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages/contracts/package.json packages/contracts/
COPY --from=build --chown=root:root /app/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=root:root /app/apps/switch-gate/package.json apps/switch-gate/
COPY --from=build --chown=root:root /app/apps/switch-gate/dist apps/switch-gate/dist
# Writable state lives only in /data (mount a volume); the private key is mounted read-only.
RUN mkdir -p /data /secrets && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
# The health server binds to 127.0.0.1 inside the container; the check runs inside it too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/switch-gate/dist/main.js"]
