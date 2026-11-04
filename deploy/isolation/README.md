# Agent isolation runtime (rootless Docker)

The fixer and the verifier each run in their own container on a **session-only rootless Docker
daemon** that belongs to your desktop user. This replaces the separate-Linux-users plan for D28
(step 6.4). Nothing here needs root, and nothing changes the system Docker.

## Layout

```
                      loopback-egress (routed)
                 ┌───────────────┴───────────────┐
      loopback-proxy-fixer           loopback-proxy-verifier      squid, one per role, alias `proxy`:
                 │                               │                HTTPS CONNECT only, named domains only
      loopback-fixer-net              loopback-verifier-net       (both --internal: no route out)
                 │                               │
      loopback-fixer                  loopback-verifier
      uid 10001, volume               uid 10002, volume
      loopback-fixer-home             loopback-verifier-home
```

Each agent can reach only its own proxy (the other proxy's name does not even resolve on its
network), so it can only ever get its own role's policy. Each agent container: non-root uid (a
host sub-uid, not your uid), all capabilities dropped, `no-new-privileges`, read-only root,
`/tmp` tmpfs, its own plain local home volume, no bind mounts, no Docker socket, no published
ports, pids/memory/cpu limits. Each proxy: user `proxy`, same hardening, on exactly its role's
network and `loopback-egress`.

Proxy rule order: non-CONNECT, non-443, IP literals and any name outside the allowlist are refused
**before** any DNS lookup, so the proxy never resolves an attacker-chosen name; allowed names are
matched exactly (`dstdomain -n`: no reverse-DNS matching), and a resolved private, loopback,
link-local or metadata address is refused.

| Destination | fixer | verifier |
|---|---|---|
| `api.github.com`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com` | yes | yes |
| `api.anthropic.com` (model provider) | yes | yes |
| `registry.npmjs.org` | only after `registry on` | never |
| anything else, IP literals, any private, LAN, loopback or `169.254.169.254` address, the other agent | no | no |

## Use

```bash
deploy/isolation/rootless-docker.sh start      # own data/exec/socket paths; no systemd, no linger, no context switch
deploy/isolation/agents.sh build               # proxy + agent images (agent image: build context = repository root)
deploy/isolation/agents.sh up                  # networks, proxy, fixer, verifier
deploy/isolation/agents.sh verifier-keygen     # verifier's Ed25519 key, created inside its container; prints the PUBLIC key
deploy/isolation/agents.sh verify              # scripts/verify-isolation.mjs: host, then inside each container
deploy/isolation/agents.sh registry on|off     # temporary npm registry access for the fixer
deploy/isolation/agents.sh down                # remove containers; home volumes are kept
deploy/isolation/rootless-docker.sh stop
```

To run any other `docker` command against this daemon, prefix it:
`DOCKER_HOST=unix://$XDG_RUNTIME_DIR/loopback-docker/docker.sock docker ps`.
State lives in `$XDG_DATA_HOME/loopback-docker` (default `~/.local/share/loopback-docker`);
delete it after `stop` to discard everything.

### Credentials (owner step)

Create `~/.config/loopback-agents/fixer.env` and `verifier.env`, each mode 600, owned by you:

```
GH_TOKEN=<that role's fine-grained token; verifier: read-only>
GH_REPO=puneetnith28/loopback-demo-target
```

plus that role's Switch and model credentials. `agents.sh up` refuses a file that is not a
regular file, not yours, not mode 600, or that sets `GITHUB_TOKEN`. Re-create a container
(`down`, `up`) after changing its file. The values are never printed.

## Prerequisites (checked by `rootless-docker.sh start`)

`rootlesskit`, `slirp4netns`, `dockerd`, `containerd`, `runc`, `newuidmap`/`newgidmap`, and a
`/etc/subuid` + `/etc/subgid` range for your user. On Ubuntu with
`kernel.apparmor_restrict_unprivileged_userns=1`, the packaged `/etc/apparmor.d/rootlesskit`
profile must be present (it is with the `rootlesskit` package). `dockerd-rootless.sh` is not
required; `rootless-docker.sh` performs its few steps itself.

If a prerequisite is missing, the owner installs it (root), for example
`sudo apt-get install rootlesskit slirp4netns uidmap`; nothing in this directory does so.

## Known limits

- You (the desktop user) own the daemon and can read both volumes, including the verifier's
  signing key. This is the same residual as the controller's user under separate users.
- `--icc=false` needs the `br_netfilter` module (root); separation instead relies on one internal
  network per role with only that role's proxy beside each agent.
- Docker's embedded DNS resolver is reachable inside; external names do not resolve there
  (checked: a resolving name fails `verify`), and the proxy does not resolve unlisted names.
- **The verifier's signing key and its tokens live in the same uid as any code the verifier runs.**
  If the verifier executes PR code (tests), that code can read the key and sign a forged report.
  Closing this needs a separate signer (own uid or container, narrow non-shell interface) and a
  keyless sandbox for PR code; not built yet.
- Allowed endpoints are exfiltration channels by design (gists/issues via an agent's token, an
  attacker-owned model API key). The allowlist narrows egress; it does not make it data-tight.
- Squid 5.7 (Debian bookworm) is installed unpinned at build time; rebuild to pick up security
  updates. The proxy is hardened and verified, but it is the shared component on the routed network.
- `64:ff9b::/96` (NAT64) is deliberately not in the blocklist: squid 5.7 then matches every IPv4
  destination. There is no NAT64 on this network.
- Run `rootless-docker.sh stop` before logging out (see the script header).
- The containers prove the sandbox, not that the real agent sessions run in it: until the fixer
  and verifier Switch sessions are started inside them (`docker exec`), verification stays
  advisory. `VERIFIER_ISOLATION_PROVEN` is never set by these scripts.
