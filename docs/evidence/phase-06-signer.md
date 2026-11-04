# D29 independent verifier signer — evidence and TDD record (2026-11-04)

Design: `docs/architecture.md` ("Verifier signing boundary (D29)"); decision D29 in `plan.md`;
threats: `docs/threat-model.md` (D29 rows). Nothing was written to GitHub or Switch; the only live
external calls were GitHub GETs (clone of the public demo repository, PR head reads by the signer).

## TDD record

| Stage | Commit / command | Result |
|---|---|---|
| RED | `19f2033` — `npx vitest run tests/unit/run-capability.test.ts tests/unit/signer-policy.test.ts tests/integration/signer-server.test.ts` | 3 files fail: `Cannot find module …/agents/capability.js` (compile-time RED) |
| GREEN | `efc26e4` — same files | 68 passed |
| RED → GREEN (gate side) | `tests/unit/config.test.ts`, `tests/integration/run-capability-issue.test.ts` | 11 failed → 52 passed |
| RED → GREEN (reader, client, runner, main) | `signer-github`, `request-signature`, `sandbox-runner`, `signer-main` tests | each failed first (missing module / behaviour), then passed |
| Review fixes (RED → GREEN) | runner freeze (`setsid` grandchild), pruning, CLI exit codes; signer idempotency, consistency, GitHub cross-check, body abort; main rotate/port/rollback | 3 + 7 + 3 failures reproduced, then passed |
| Full suite | `npm run test:coverage` | 985 passed, 4 skipped; statements 92.23 %, branches 86.25 %, functions 90.03 %, lines 95.1 % |
| Gates | `npm run typecheck`, `npm run lint`, `npm run build` | clean |

| # | Guarantee | Test | Type |
|---|---|---|---|
| 1 | A capability verifies only with the gate's issuer key, unaltered, unexpired, schema-valid | `unit/run-capability.test.ts` | unit |
| 2 | The signer signs only a strict, unsigned, consistent report whose digest matches, under a capability for the same run/case/repo/PR/SHA, for its repository, at the live head | `unit/signer-policy.test.ts` | unit |
| 3 | One report per run: identical retry → same signature; any other report → `REPLAYED` (also concurrent and after restart) | `unit/signer-policy.test.ts`, `integration/signer-server.test.ts` | unit, integration |
| 4 | Token checked before the body (constant time); 64 KiB cap with prompt abort; JSON only; rate limit; no secrets/report text/signature in logs | `integration/signer-server.test.ts` | integration |
| 5 | Live head read only via the CONNECT proxy over verified TLS; answer must be this PR in this repository | `integration/signer-github.test.ts` | integration (real TLS + proxy) |
| 6 | Gate issues a capability bound to each run, new on re-run and new head | `integration/run-capability-issue.test.ts` | integration |
| 7 | Gate → signer → gate end to end; superseded run still rejected by the gate | `integration/signer-gate-e2e.test.ts` | integration |
| 8 | Verifier client holds only a token, bypasses the proxy, validates the answer | `integration/request-signature.test.ts` | integration |
| 9 | Runner: argv only, minimal env, bounded output, group kill, not frozen by `setsid`, survives `chmod 000`, one job at a time, symlink results refused, pruning | `integration/sandbox-runner.test.ts` | integration |
| 10 | Signer process: owner-only key/token, no overwrite, rollback, rotation, fail-closed start | `integration/signer-main.test.ts` | integration |
| 11 | Isolation checker fails for every weakening of signer, runner, verifier layout and volume ownership | `unit/verify-isolation.test.ts`, `integration/verify-isolation.test.ts` | unit, integration |
| 12 | `signer/**` cannot import gate state, transport, merge or audit | `unit/lint-boundaries.test.ts` | unit |

Known gaps: the in-container `signerRole`/`runnerRole` checks run only live (below); the PID-1
stray sweep of the runner is exercised only in the container.

## Live: container isolation (`deploy/isolation/agents.sh verify`, after review fixes)

339 checks PASS; the only FAIL is the verifier's GitHub read (its read-only token is an owner
step). Signer listens on its signer-network address only (`172.21.0.3:8080`). Full output:

```text
== isolation checks (host)
PASS  DOCKER_HOST is a per-user unix socket, not the rootful daemon
PASS  DOCKER_HOST is the Loopback daemon (/run/user/1000/loopback-docker/docker.sock)
PASS  the daemon runs rootless
PASS  the daemon applies a seccomp profile
PASS  the daemon's data root is not the system Docker's
PASS  fixer: container is running
PASS  fixer: not privileged
PASS  fixer: all capabilities dropped, none added
PASS  fixer: no-new-privileges set
PASS  fixer: seccomp/AppArmor not disabled
PASS  fixer: read-only root filesystem
PASS  fixer: no host bind mounts
PASS  fixer: volumes use the local driver
PASS  fixer: no Docker socket mounted
PASS  fixer: no host devices
PASS  fixer: shares no host namespace
PASS  fixer: publishes no ports
PASS  fixer: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  fixer: default runtime (runc)
PASS  fixer: pids and memory limits set
PASS  fixer: runs as uid/gid 10001
PASS  fixer: home is its own volume loopback-fixer-home
PASS  fixer: only its own volumes, each at its place and mode
PASS  fixer: attached exactly to [loopback-fixer-net]
PASS  fixer: loopback-fixer-net is internal (no route out)
PASS  fixer: only its own proxy shares its network
PASS  fixer: GITHUB_TOKEN not set
PASS  fixer: LOOPBACK_AGENT_ROLE=fixer
PASS  fixer: HTTPS_PROXY is its own proxy
PASS  loopback-proxy-fixer: container is running
PASS  loopback-proxy-fixer: not privileged
PASS  loopback-proxy-fixer: all capabilities dropped, none added
PASS  loopback-proxy-fixer: no-new-privileges set
PASS  loopback-proxy-fixer: seccomp/AppArmor not disabled
PASS  loopback-proxy-fixer: read-only root filesystem
PASS  loopback-proxy-fixer: no host bind mounts
PASS  loopback-proxy-fixer: volumes use the local driver
PASS  loopback-proxy-fixer: no Docker socket mounted
PASS  loopback-proxy-fixer: no host devices
PASS  loopback-proxy-fixer: shares no host namespace
PASS  loopback-proxy-fixer: publishes no ports
PASS  loopback-proxy-fixer: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  loopback-proxy-fixer: default runtime (runc)
PASS  loopback-proxy-fixer: pids and memory limits set
PASS  loopback-proxy-fixer: runs as a non-root user (proxy)
PASS  loopback-proxy-fixer: on exactly loopback-fixer-net and loopback-egress
PASS  loopback-proxy-fixer: serves the fixer policy
PASS  verifier: container is running
PASS  verifier: not privileged
PASS  verifier: all capabilities dropped, none added
PASS  verifier: no-new-privileges set
PASS  verifier: seccomp/AppArmor not disabled
PASS  verifier: read-only root filesystem
PASS  verifier: no host bind mounts
PASS  verifier: volumes use the local driver
PASS  verifier: no Docker socket mounted
PASS  verifier: no host devices
PASS  verifier: shares no host namespace
PASS  verifier: publishes no ports
PASS  verifier: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  verifier: default runtime (runc)
PASS  verifier: pids and memory limits set
PASS  verifier: runs as uid/gid 10002
PASS  verifier: home is its own volume loopback-verifier-home
PASS  verifier: only its own volumes, each at its place and mode
PASS  verifier: attached exactly to [loopback-verifier-net, loopback-signer-net]
PASS  verifier: loopback-verifier-net is internal (no route out)
PASS  verifier: only its own proxy shares its network
PASS  verifier: GITHUB_TOKEN not set
PASS  verifier: LOOPBACK_AGENT_ROLE=verifier
PASS  verifier: HTTPS_PROXY is its own proxy
PASS  loopback-proxy-verifier: container is running
PASS  loopback-proxy-verifier: not privileged
PASS  loopback-proxy-verifier: all capabilities dropped, none added
PASS  loopback-proxy-verifier: no-new-privileges set
PASS  loopback-proxy-verifier: seccomp/AppArmor not disabled
PASS  loopback-proxy-verifier: read-only root filesystem
PASS  loopback-proxy-verifier: no host bind mounts
PASS  loopback-proxy-verifier: volumes use the local driver
PASS  loopback-proxy-verifier: no Docker socket mounted
PASS  loopback-proxy-verifier: no host devices
PASS  loopback-proxy-verifier: shares no host namespace
PASS  loopback-proxy-verifier: publishes no ports
PASS  loopback-proxy-verifier: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  loopback-proxy-verifier: default runtime (runc)
PASS  loopback-proxy-verifier: pids and memory limits set
PASS  loopback-proxy-verifier: runs as a non-root user (proxy)
PASS  loopback-proxy-verifier: on exactly loopback-verifier-net and loopback-egress
PASS  loopback-proxy-verifier: serves the verifier policy
PASS  loopback-proxy-verifier: has no registry access
PASS  signer: container is running
PASS  signer: not privileged
PASS  signer: all capabilities dropped, none added
PASS  signer: no-new-privileges set
PASS  signer: seccomp/AppArmor not disabled
PASS  signer: read-only root filesystem
PASS  signer: no host bind mounts
PASS  signer: volumes use the local driver
PASS  signer: no Docker socket mounted
PASS  signer: no host devices
PASS  signer: shares no host namespace
PASS  signer: publishes no ports
PASS  signer: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  signer: default runtime (runc)
PASS  signer: pids and memory limits set
PASS  signer: runs as uid/gid 10003
PASS  signer: only its own volumes, each at its place and mode
PASS  signer: key volume loopback-signer-home mounted
PASS  signer: attached exactly to [loopback-signer-net, loopback-signer-egress-net]
PASS  signer: loopback-signer-net is internal and shared only with the verifier
PASS  signer: loopback-signer-egress-net is internal and shared only with its proxy
PASS  signer: no GitHub write-capable token variable
PASS  signer: uses its own proxy
PASS  loopback-proxy-signer: container is running
PASS  loopback-proxy-signer: not privileged
PASS  loopback-proxy-signer: all capabilities dropped, none added
PASS  loopback-proxy-signer: no-new-privileges set
PASS  loopback-proxy-signer: seccomp/AppArmor not disabled
PASS  loopback-proxy-signer: read-only root filesystem
PASS  loopback-proxy-signer: no host bind mounts
PASS  loopback-proxy-signer: volumes use the local driver
PASS  loopback-proxy-signer: no Docker socket mounted
PASS  loopback-proxy-signer: no host devices
PASS  loopback-proxy-signer: shares no host namespace
PASS  loopback-proxy-signer: publishes no ports
PASS  loopback-proxy-signer: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  loopback-proxy-signer: default runtime (runc)
PASS  loopback-proxy-signer: pids and memory limits set
PASS  loopback-proxy-signer: runs as a non-root user (proxy)
PASS  loopback-proxy-signer: on exactly loopback-signer-egress-net and loopback-egress
PASS  loopback-proxy-signer: serves the signer policy
PASS  loopback-proxy-signer: has no registry access
PASS  runner: container is running
PASS  runner: not privileged
PASS  runner: all capabilities dropped, none added
PASS  runner: no-new-privileges set
PASS  runner: seccomp/AppArmor not disabled
PASS  runner: read-only root filesystem
PASS  runner: no host bind mounts
PASS  runner: volumes use the local driver
PASS  runner: no Docker socket mounted
PASS  runner: no host devices
PASS  runner: shares no host namespace
PASS  runner: publishes no ports
PASS  runner: no volumes-from, extra hosts, sysctls, extra groups or links
PASS  runner: default runtime (runc)
PASS  runner: pids and memory limits set
PASS  runner: runs as uid/gid 10004
PASS  runner: has no network (--network none)
PASS  runner: only its own volumes, each at its place and mode
PASS  runner: no credentials in its environment
PASS  volume loopback-fixer-home is a plain local volume
PASS  volume loopback-verifier-home is a plain local volume
PASS  volume loopback-signer-home is a plain local volume
PASS  volume loopback-runner-jobs is a plain local volume
PASS  volume loopback-runner-results is a plain local volume
PASS  loopback-signer-home is mounted by the signer alone
PASS  the fixer mounts no runner volume
PASS  fixer and verifier run as different uids
PASS  fixer and verifier share no volume
PASS  fixer and verifier share no network
PASS  gate key is owner-only
INFO  residual (documented): the desktop user owns the rootless daemon and can read every volume, including the signer's key
== summary
every check for role host passed (one part of the evidence; isolation is not proven by this alone)
== isolation checks (fixer)
PASS  HOME is the role's own 0700 home
PASS  the other role's home (/home/verifier) is not readable (EACCES)
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  no Docker socket or DOCKER_HOST inside
PASS  /opt/loopback is root-owned and not writable by others
PASS  /opt/loopback/verify-isolation.mjs is root-owned and not writable by others
PASS  /opt/loopback/request-signature.mjs is root-owned and not writable by others
PASS  /opt/loopback/run-in-sandbox.mjs is root-owned and not writable by others
PASS  /opt/loopback/sandbox-runner.mjs is root-owned and not writable by others
PASS  /opt/loopback/signature.js is root-owned and not writable by others
PASS  /opt/loopback-app is root-owned and not writable by others
PASS  /opt/loopback-app/node_modules is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/main.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/policy.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/server.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/replay.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/github-pull.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/capability.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/signature.js is root-owned and not writable by others
PASS  direct connection to the internet (1.1.1.1:443): no route (ENETUNREACH)
PASS  direct connection to GitHub without the proxy (140.82.112.3:443): no route (ENETUNREACH)
PASS  direct connection to the cloud metadata address: no route (ENETUNREACH)
PASS  direct connection to the rootless host gateway (10.0.2.2): no route (ENETUNREACH)
PASS  direct connection to the rootless DNS forwarder (10.0.2.3): no route (ENETUNREACH)
PASS  direct connection to a typical LAN router (192.168.1.1): no route (ENETUNREACH)
PASS  loopback-verifier is not reachable (EAI_AGAIN)
PASS  loopback-proxy-verifier is not reachable (EAI_AGAIN)
PASS  external DNS names do not resolve inside
PASS  proxy CONNECT api.github.com:443 → 200
PASS  proxy CONNECT github.com:443 → 200
PASS  proxy CONNECT api.anthropic.com:443 → 200
PASS  proxy CONNECT example.com:443 → 403
PASS  proxy CONNECT lb-e28776c9d931.example.org:443 → 403
PASS  proxy CONNECT gist.github.com:443 → 403
PASS  proxy CONNECT evil.api.github.com:443 → 403
PASS  proxy CONNECT 169.254.169.254:443 → 403
PASS  proxy CONNECT 140.82.112.3:443 → 403
PASS  proxy CONNECT [::1]:443 → 403
PASS  proxy CONNECT 10.0.2.2:443 → 403
PASS  proxy CONNECT api.github.com:80 → 403
INFO  proxy CONNECT registry.npmjs.org:443 → 403 (registry access is toggled by the owner)
PASS  proxy CONNECT loopback-verifier:443 → 403
PASS  proxy refuses plain HTTP (403)
PASS  GITHUB_TOKEN not set
INFO  no GH_TOKEN set yet (owner-supplied role env file)
INFO  no git credential helper
PASS  the signer (signer) is not reachable from the fixer (EAI_AGAIN)
PASS  the signer (loopback-signer) is not reachable from the fixer (EAI_AGAIN)
== summary
every check for role fixer passed (one part of the evidence; isolation is not proven by this alone)
== isolation checks (verifier)
PASS  HOME is the role's own 0700 home
PASS  the other role's home (/home/fixer) is not readable (EACCES)
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  no Docker socket or DOCKER_HOST inside
PASS  /opt/loopback is root-owned and not writable by others
PASS  /opt/loopback/verify-isolation.mjs is root-owned and not writable by others
PASS  /opt/loopback/request-signature.mjs is root-owned and not writable by others
PASS  /opt/loopback/run-in-sandbox.mjs is root-owned and not writable by others
PASS  /opt/loopback/sandbox-runner.mjs is root-owned and not writable by others
PASS  /opt/loopback/signature.js is root-owned and not writable by others
PASS  /opt/loopback-app is root-owned and not writable by others
PASS  /opt/loopback-app/node_modules is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/main.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/policy.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/server.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/replay.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/github-pull.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/capability.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/signature.js is root-owned and not writable by others
PASS  direct connection to the internet (1.1.1.1:443): no route (ENETUNREACH)
PASS  direct connection to GitHub without the proxy (140.82.112.3:443): no route (ENETUNREACH)
PASS  direct connection to the cloud metadata address: no route (ENETUNREACH)
PASS  direct connection to the rootless host gateway (10.0.2.2): no route (ENETUNREACH)
PASS  direct connection to the rootless DNS forwarder (10.0.2.3): no route (ENETUNREACH)
PASS  direct connection to a typical LAN router (192.168.1.1): no route (ENETUNREACH)
PASS  loopback-fixer is not reachable (EAI_AGAIN)
PASS  loopback-proxy-fixer is not reachable (EAI_AGAIN)
PASS  external DNS names do not resolve inside
PASS  proxy CONNECT api.github.com:443 → 200
PASS  proxy CONNECT github.com:443 → 200
PASS  proxy CONNECT api.anthropic.com:443 → 200
PASS  proxy CONNECT example.com:443 → 403
PASS  proxy CONNECT lb-05c6bfd339be.example.org:443 → 403
PASS  proxy CONNECT gist.github.com:443 → 403
PASS  proxy CONNECT evil.api.github.com:443 → 403
PASS  proxy CONNECT 169.254.169.254:443 → 403
PASS  proxy CONNECT 140.82.112.3:443 → 403
PASS  proxy CONNECT [::1]:443 → 403
PASS  proxy CONNECT 10.0.2.2:443 → 403
PASS  proxy CONNECT api.github.com:80 → 403
PASS  proxy CONNECT registry.npmjs.org:443 → 403
PASS  proxy CONNECT loopback-fixer:443 → 403
PASS  proxy refuses plain HTTP (403)
PASS  GITHUB_TOKEN not set
INFO  no GH_TOKEN set yet (owner-supplied role env file)
PASS  verifier has no git credential helper
PASS  no private key anywhere in the verifier's home
PASS  the signer's key directory is not here
PASS  the signer client token is the verifier's own (mode 600)
PASS  the signer answers on the signer network
PASS  the signer refuses an unauthenticated request (401)
PASS  the runner is not reachable over the network (EAI_AGAIN)
FAIL  cannot show read access (needs GH_REPO and GH_TOKEN in the verifier's env file)
== summary
1 failure(s) for role verifier
== verdict: NOT PROVEN
== isolation checks (signer)
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  no Docker socket or DOCKER_HOST inside
PASS  /opt/loopback is root-owned and not writable by others
PASS  /opt/loopback/verify-isolation.mjs is root-owned and not writable by others
PASS  /opt/loopback/request-signature.mjs is root-owned and not writable by others
PASS  /opt/loopback/run-in-sandbox.mjs is root-owned and not writable by others
PASS  /opt/loopback/sandbox-runner.mjs is root-owned and not writable by others
PASS  /opt/loopback/signature.js is root-owned and not writable by others
PASS  /opt/loopback-app is root-owned and not writable by others
PASS  /opt/loopback-app/node_modules is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/main.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/policy.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/server.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/replay.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/github-pull.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/capability.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/signature.js is root-owned and not writable by others
PASS  the signing key is the signer's own (mode 600)
PASS  /home/fixer is not readable (EACCES)
PASS  /home/verifier is not readable (EACCES)
PASS  direct connection to the internet (1.1.1.1:443): no route (ENETUNREACH)
PASS  direct connection to GitHub without the proxy (140.82.112.3:443): no route (ENETUNREACH)
PASS  direct connection to the cloud metadata address: no route (ENETUNREACH)
PASS  direct connection to the rootless host gateway (10.0.2.2): no route (ENETUNREACH)
PASS  direct connection to the rootless DNS forwarder (10.0.2.3): no route (ENETUNREACH)
PASS  direct connection to a typical LAN router (192.168.1.1): no route (ENETUNREACH)
PASS  signer proxy CONNECT api.github.com:443 → 200
PASS  signer proxy CONNECT github.com:443 → 403
PASS  signer proxy CONNECT example.com:443 → 403
PASS  signer proxy CONNECT api.anthropic.com:443 → 403
PASS  signer proxy CONNECT 169.254.169.254:443 → 403
PASS  loopback-fixer is not reachable (EAI_AGAIN)
PASS  loopback-proxy-fixer is not reachable (EAI_AGAIN)
PASS  loopback-runner is not reachable (EAI_AGAIN)
PASS  no GH_TOKEN/GITHUB_TOKEN
== summary
every check for role signer passed (one part of the evidence; isolation is not proven by this alone)
== isolation checks (runner)
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  no Docker socket or DOCKER_HOST inside
PASS  /opt/loopback is root-owned and not writable by others
PASS  /opt/loopback/verify-isolation.mjs is root-owned and not writable by others
PASS  /opt/loopback/request-signature.mjs is root-owned and not writable by others
PASS  /opt/loopback/run-in-sandbox.mjs is root-owned and not writable by others
PASS  /opt/loopback/sandbox-runner.mjs is root-owned and not writable by others
PASS  /opt/loopback/signature.js is root-owned and not writable by others
PASS  /opt/loopback-app is root-owned and not writable by others
PASS  /opt/loopback-app/node_modules is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/main.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/policy.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/server.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/replay.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/signer/github-pull.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/capability.js is root-owned and not writable by others
PASS  /opt/loopback-app/apps/switch-gate/dist/agents/signature.js is root-owned and not writable by others
PASS  no credential variables in the environment
PASS  /home/fixer is not readable (EACCES)
PASS  /home/verifier is not readable (EACCES)
PASS  /home/signer is not readable (EACCES)
PASS  no private key visible
PASS  direct connection to the internet (1.1.1.1:443): no route (ENETUNREACH)
PASS  direct connection to GitHub without the proxy (140.82.112.3:443): no route (ENETUNREACH)
PASS  direct connection to the cloud metadata address: no route (ENETUNREACH)
PASS  direct connection to the rootless host gateway (10.0.2.2): no route (ENETUNREACH)
PASS  direct connection to the rootless DNS forwarder (10.0.2.3): no route (ENETUNREACH)
PASS  direct connection to a typical LAN router (192.168.1.1): no route (ENETUNREACH)
PASS  signer is not reachable (EAI_AGAIN)
PASS  loopback-signer is not reachable (EAI_AGAIN)
PASS  proxy is not reachable (EAI_AGAIN)
PASS  loopback-verifier is not reachable (EAI_AGAIN)
PASS  no DNS resolution
PASS  the jobs volume is mounted read-only in the runner
== summary
every check for role runner passed (one part of the evidence; isolation is not proven by this alone)
```

## Live: regression test executed in the runner (no network, no credentials)

Demo repository cloned by the verifier through its proxy; tests submitted with
`run-in-sandbox.mjs --tree . -- node --test test/index.test.js`:

| Commit | Result |
|---|---|
| `70a5362` (demo-reset, seeded bug) | exit 1 — 5 pass, 1 fail: `Issue #1 … TypeError: Cannot read properties of null (reading 'toString')` |
| `e804775` (PR #2 head) | exit 0 — 6 pass, 0 fail |

## Live: signing (capabilities issued with the gate's run-issuer key for PR #2)

| Request | Signer answer |
|---|---|
| Valid report, live head `e804775` | signed; the gate's `verifyReportSignature` with the signer public key → `{"ok":true}`; verdict or head altered → `{"ok":false,"reason":"invalid"}` |
| Identical retry | same signature (idempotent) |
| Different report for the same run | `REPLAYED` |
| Capability for `70a5362` (no longer the PR head) | `STALE_HEAD` (read live from GitHub) |
| Capability signed by a non-gate key | `CAPABILITY_INVALID` |
| `pass` with `regressionTestFailsBeforeFix:false` | `REPORT_INCONSISTENT` |
| No/wrong token | 401 `UNAUTHENTICATED` |
| From the fixer or the runner | `signer` does not resolve (`EAI_AGAIN`) |
| Old token after `signer-rotate-token` | 401; new token authenticates |

Signer public key (not secret; the owner sets it as the gate's `VERIFIER_PUBLIC_KEY`):

```text
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAElyXiLq8ap0k9LnmWXFbGhJvFcvr8Ihf6Cec0lmbcJY=
-----END PUBLIC KEY-----
```

The D28 key generated earlier inside the verifier was removed by `agents.sh signer-token`; the
verifier check "no private key anywhere in the verifier's home" passes.

## Independent reviews (ECC agents) and dispositions

- `ecc:code-reviewer`: 1 HIGH (runner frozen by a `setsid` grandchild) — fixed with test; MEDIUM
  (results growth, one bad job blocking the queue, weak runner tests, untested CLI/main) — fixed
  with tests; LOW docs/robustness — fixed. Accepted: `findPrivateKeys` may FAIL on a PEM fixture
  in a cloned repo (fails closed).
- `ecc:security-reviewer`: no CRITICAL/HIGH. MEDIUM runner wedge (`chmod 000`) and cross-job
  result forgery — fixed (best-effort cleanup, per-job isolation, stray sweep, one job at a time,
  O_NOFOLLOW result read). LOW: idempotent replay, GitHub cross-check, body abort, signature
  format check, bind address, mountinfo RO probe, tooling coverage — fixed. Accepted: plain HTTP
  on the two-member signer network; no capability audience (single deployment).
- `ecc:architect`: H1 residual over-claimed — wording corrected everywhere, `recycle-verifier`
  and `signer-rotate-token` added, conflicting requests refused and logged; H2 verifier exposed to
  injection every run — documented, brief requires a fresh run directory and no project-config
  tools (owner launch setting); H3 runner forgery — fixed as above. M1 idempotency, M2 rotation,
  M5 consistency rules — fixed; M3 stale D28 key — readiness check compares
  `VERIFIER_PUBLIC_KEY` with the signer's key. Recorded follow-ups, not built: attested execution
  (dispatcher signs execution facts, per-job containers), per-run verifier credentials delivered
  out of band, capability hash and signing time inside the signed report (M4), key ids/rotation
  windows for the signing and issuer keys, version pinning between gate and image (M6).

## Not shown here

`VERIFIER_ISOLATION_PROVEN` stays false: the verifier's read-only token, the agent sessions
running inside the containers, and a live signed report through Switch are owner steps.
