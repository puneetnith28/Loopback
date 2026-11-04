# Fixer / verifier agent image (D28, step 6.4). Build context: the repository root
#   docker build -f deploy/isolation/agent/Dockerfile .
# One image, two identities: uid 10001 (fixer) and uid 10002 (verifier). Under the rootless
# daemon these map to distinct host sub-uids, neither of which is the desktop user. Each home is
# 0700 and becomes the role's own named volume at run time. The image carries no credentials.
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY apps/switch-gate/package.json apps/switch-gate/tsconfig.json apps/switch-gate/
# Only the TypeScript build is needed (for signature.js); skip native install scripts.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/contracts/src packages/contracts/src
COPY apps/switch-gate/src apps/switch-gate/src
RUN npx tsc -b

FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 fixer && useradd -u 10001 -g 10001 -d /home/fixer -M -s /bin/bash fixer \
    && groupadd -g 10002 verifier && useradd -u 10002 -g 10002 -d /home/verifier -M -s /bin/bash verifier \
    && install -d -o fixer -g fixer -m 0700 /home/fixer \
    && install -d -o verifier -g verifier -m 0700 /home/verifier
# Root-owned, read-only tooling: the isolation checker and the signing helper with the gate's
# canonicalization module beside it (the "system-wide install" sign-verifier-report.mjs expects).
COPY scripts/verify-isolation.mjs /opt/loopback/verify-isolation.mjs
COPY scripts/sign-verifier-report.mjs /usr/local/lib/loopback-signer/sign-verifier-report.mjs
COPY --from=build /app/apps/switch-gate/dist/agents/signature.js /usr/local/lib/loopback-signer/signature.js
RUN printf '{"type":"module"}\n' >/usr/local/lib/loopback-signer/package.json \
    && printf '{"type":"module"}\n' >/opt/loopback/package.json \
    && chown -R root:root /opt/loopback /usr/local/lib/loopback-signer \
    && chmod 0755 /opt/loopback /usr/local/lib/loopback-signer \
    && chmod 0644 /opt/loopback/* /usr/local/lib/loopback-signer/*
ENV LOOPBACK_SIGNER_DIR=/usr/local/lib/loopback-signer
# Idle until the agent session is attached with `docker exec`; the container is the sandbox.
CMD ["sleep", "infinity"]
