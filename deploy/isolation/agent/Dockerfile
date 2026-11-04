# Agent-runtime image (D28, D29, step 6.4). Build context: the repository root
#   docker build -f deploy/isolation/agent/Dockerfile .
# One image, four identities, each a distinct host sub-uid under the rootless daemon:
#   10001 fixer     writes code, opens PRs
#   10002 verifier  reviews; holds the signer client token, never a signing key; runs no PR code
#   10003 signer    holds the verifier signing key (its own volume); signs only gate-issued runs
#   10004 runner    executes PR code (tests) with no network and no credentials
# Homes are 0700 and become named volumes at run time. The image carries no credentials.
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY apps/switch-gate/package.json apps/switch-gate/tsconfig.json apps/switch-gate/
# Only the TypeScript build is needed; skip native install scripts (better-sqlite3 is unused here).
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/contracts/src packages/contracts/src
COPY apps/switch-gate/src apps/switch-gate/src
RUN npx tsc -b apps/switch-gate && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN for spec in fixer:10001 verifier:10002 signer:10003 runner:10004; do \
      name="${spec%%:*}"; id="${spec##*:}"; \
      groupadd -g "$id" "$name" && useradd -u "$id" -g "$id" -d "/home/$name" -M -s /bin/bash "$name" \
      && install -d -o "$name" -g "$name" -m 0700 "/home/$name"; \
    done \
    && install -d -o verifier -g verifier -m 0755 /jobs \
    && install -d -o runner -g runner -m 0755 /results
# Root-owned runtime for the signer service (compiled gate modules + production dependencies).
COPY --from=build /app/package.json /opt/loopback-app/package.json
COPY --from=build /app/node_modules /opt/loopback-app/node_modules
COPY --from=build /app/packages/contracts/package.json /opt/loopback-app/packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist /opt/loopback-app/packages/contracts/dist
COPY --from=build /app/apps/switch-gate/package.json /opt/loopback-app/apps/switch-gate/package.json
COPY --from=build /app/apps/switch-gate/dist /opt/loopback-app/apps/switch-gate/dist
# Root-owned tooling: the isolation checker, the runner daemon and its client, and the signer
# client with the gate's canonicalization module beside it (digest only; it holds no key).
COPY scripts/verify-isolation.mjs scripts/sandbox-runner.mjs scripts/run-in-sandbox.mjs scripts/request-signature.mjs /opt/loopback/
COPY --from=build /app/apps/switch-gate/dist/agents/signature.js /opt/loopback/signature.js
RUN printf '{"type":"module"}\n' >/opt/loopback/package.json \
    && chown -R root:root /opt/loopback /opt/loopback-app \
    && chmod -R go-w /opt/loopback /opt/loopback-app \
    && chmod 0755 /opt/loopback && chmod 0644 /opt/loopback/*
ENV LOOPBACK_SIGNER_URL=http://signer:8080/v1/sign
# Idle until a session is attached with `docker exec`; signer and runner override the command.
CMD ["sleep", "infinity"]
