# Phase 6.4 — container isolation evidence (2026-11-04)

Runtime: `deploy/isolation/` on this host (Ubuntu, kernel 6.17, docker.io 29.1.3, rootlesskit 2.0.2,
slirp4netns 1.2.1, squid 5.7). Session-only rootless daemon at
`$XDG_RUNTIME_DIR/loopback-docker/docker.sock`; the rootful daemon and the default docker context
were not touched.

Commands: `deploy/isolation/rootless-docker.sh start`, `deploy/isolation/agents.sh build`, `up`,
`verifier-keygen`, `verify`. Full output of the last `verify` run (after the review fixes), unedited:

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
PASS  fixer: attached only to loopback-fixer-net
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
PASS  verifier: attached only to loopback-verifier-net
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
PASS  volume loopback-fixer-home is a plain local volume
PASS  volume loopback-verifier-home is a plain local volume
PASS  fixer and verifier run as different uids
PASS  fixer and verifier share no volume
PASS  fixer and verifier share no network
PASS  gate key is owner-only
INFO  residual (documented): the desktop user owns the rootless daemon and can read the agents' volumes
== summary
every check for role host passed (one part of the evidence; isolation is not proven by this alone)
== isolation checks (fixer)
PASS  HOME is the role's own 0700 home
PASS  the other role's home (/home/verifier) is not readable (EACCES)
PASS  no Docker socket or DOCKER_HOST inside
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  /usr/local/lib/loopback-signer is root-owned and not writable by others
PASS  /usr/local/lib/loopback-signer/sign-verifier-report.mjs is root-owned and not writable by others
PASS  /usr/local/lib/loopback-signer/signature.js is root-owned and not writable by others
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
PASS  proxy CONNECT lb-47b7ee5550b5.example.org:443 → 403
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
== summary
every check for role fixer passed (one part of the evidence; isolation is not proven by this alone)
== isolation checks (verifier)
PASS  HOME is the role's own 0700 home
PASS  the other role's home (/home/fixer) is not readable (EACCES)
PASS  no Docker socket or DOCKER_HOST inside
PASS  no effective capabilities
PASS  no_new_privs is set
PASS  root filesystem is read-only
PASS  /usr/local/lib/loopback-signer is root-owned and not writable by others
PASS  /usr/local/lib/loopback-signer/sign-verifier-report.mjs is root-owned and not writable by others
PASS  /usr/local/lib/loopback-signer/signature.js is root-owned and not writable by others
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
PASS  proxy CONNECT lb-2f92a0872107.example.org:443 → 403
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
PASS  the signing key is the verifier's own (mode 600)
FAIL  cannot show read access (needs GH_REPO and GH_TOKEN in the verifier's env file)
== summary
1 failure(s) for role verifier
== verdict: NOT PROVEN
```

## Additional observations from the same session

- Registry toggle: with `agents.sh registry on`, the fixer's proxy allows `registry.npmjs.org:443` (200)
  while the verifier's stays 403; `registry off` restores 403 for the fixer. `api.anthropic.com` → 200 for both.
- Cross-role: the verifier cannot resolve `loopback-proxy-fixer` (EAI_AGAIN), so it cannot use the
  fixer's policy; through its own proxy the other agent's name is refused (403).
- Stale checker guard: with the repository copy of `verify-isolation.mjs` changed, `agents.sh verify`
  refuses ("carries an outdated verify-isolation.mjs").
- Image write attempt: `docker cp` into the running fixer is refused (`container rootfs is marked read-only`).
- Verifier signing key: generated inside the verifier container by `agents.sh verifier-keygen`
  (uid 10002, mode 600, its own volume); a second run refuses to overwrite it. A sample report signed
  inside the container with the installed helper verifies with the gate's `verifyReportSignature`
  (`{"ok":true}`); the same report with `verdict` changed is rejected (`{"ok":false,"reason":"invalid"}`).
  Public key (not secret; the owner sets it as the gate's `VERIFIER_PUBLIC_KEY`):

  ```text
  -----BEGIN PUBLIC KEY-----
  MCowBQYDK2VwAyEAsWAC4dkvYlHGfnCQH9t7BgHWIlcfzLJSUfO+P6XhXp8=
  -----END PUBLIC KEY-----
  ```

## Review findings fixed before this run

Independent code and security reviews (2026-11-04) found, and live probes confirmed: the verifier
could use the fixer's proxy port (and so its registry access) — fixed with one proxy per role;
probes passed on non-evidence (timeouts, any non-200) — now only "no route" or the proxy's 403
count; the proxy container itself was not inspected — now checked. Also fixed: allowlist checked
before any DNS lookup, `dstdomain -n`, IP literals refused, more container fields checked, exact
Loopback socket required, `.dockerignore` patterns at any depth, stopped containers re-created
by `up`. Two squid 5.7 pitfalls found while testing and avoided (documented in `squid.conf`): a
multi-file `dstdomain` line loads only its first file, and `64:ff9b::/96` in a `dst` ACL matches
every IPv4 destination.

## What this does not show (VERIFIER_ISOLATION_PROVEN stays false)

- The verifier's read-only GitHub token is not issued yet (owner step 6.3), so the read GET and the
  write-refusal probes are not run.
- No agent session runs inside the containers yet: the fixer/verifier Switch registrations and their
  credentials are owner steps (7.1, 7.2). Until then the containers prove the sandbox, not that the
  real agents use it.
- No live signed report has passed through Switch to the gate.
- Open design gap: the signing key shares uid 10002 with any PR code the verifier runs.
- Residuals: the desktop user owns the rootless daemon and can read both volumes; `--icc=false` is
  unavailable without root; allowed endpoints remain exfiltration channels by design.
