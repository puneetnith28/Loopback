#!/usr/bin/env bash
# Fixer / verifier containers on the Loopback rootless daemon (D28, step 6.4).
#
#   deploy/isolation/agents.sh build              build the egress-proxy and agent images
#   deploy/isolation/agents.sh up                 create networks, start both proxies and both agents
#   deploy/isolation/agents.sh down               remove the containers (home volumes are kept)
#   deploy/isolation/agents.sh status             list the containers
#   deploy/isolation/agents.sh verify             run verify-isolation.mjs for host, fixer, verifier
#   deploy/isolation/agents.sh registry on|off    allow / stop the fixer's npm registry access
#   deploy/isolation/agents.sh verifier-keygen    create the verifier's Ed25519 signing key inside
#                                                 its container; prints only the PUBLIC key
#
# Credentials: optional per-role env files $CRED_DIR/fixer.env and $CRED_DIR/verifier.env
# (default ~/.config/loopback-agents), each a regular file owned by you with mode 600, holding
# that role's GH_TOKEN (fine-grained PAT; verifier read-only), GH_REPO and its Switch/model
# credentials. GITHUB_TOKEN is refused. Nothing here prints a credential.
#
# Topology: loopback-fixer-net and loopback-verifier-net are --internal (no route out). Each holds
# one agent and that role's own egress proxy (alias `proxy`); only the proxies are also on
# loopback-egress (routed). A role can therefore reach only its own proxy and its own policy.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CRED_DIR="${LOOPBACK_AGENT_CRED_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/loopback-agents}"
STATE_DIR="${LOOPBACK_DOCKER_RUN_DIR:-${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/loopback-docker}"
PROXY_IMG=loopback-egress-proxy:local
AGENT_IMG=loopback-agent:local
EGRESS_NET=loopback-egress
ROLES=(fixer verifier)

die() { echo "agents: $*" >&2; exit 1; }

DOCKER_HOST="$("$HERE/rootless-docker.sh" env)"; DOCKER_HOST="${DOCKER_HOST#DOCKER_HOST=}"; export DOCKER_HOST
"$HERE/rootless-docker.sh" status >/dev/null || die "the Loopback rootless daemon is not running; start it with $HERE/rootless-docker.sh start"

role_uid() { case "$1" in fixer) echo 10001 ;; verifier) echo 10002 ;; esac; }

exists() { docker "$1" inspect "$2" >/dev/null 2>&1; }
is_running() { [ "$(docker container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

ensure_network() { # name internal(true|false)
  if exists network "$1"; then
    [ "$(docker network inspect -f '{{.Internal}}' "$1")" = "$2" ] || die "network $1 exists with internal=$(docker network inspect -f '{{.Internal}}' "$1"), expected $2; run '$0 down' and remove it"
  elif [ "$2" = true ]; then
    docker network create --internal "$1" >/dev/null
  else
    docker network create "$1" >/dev/null
  fi
}

registry_flag() { cat "$STATE_DIR/fixer-registry" 2>/dev/null || echo 0; }

# An existing container is reused only if running; a stopped or half-created one is replaced
# (its configuration is fixed at creation, so re-creating it is always safe; volumes persist).
reuse_or_remove() { # name -> 0 if it is running and can be kept
  exists container "$1" || return 1
  is_running "$1" && return 0
  docker rm -f "$1" >/dev/null
  return 1
}

start_proxy() { # role [registry-flag]
  local role="$1" name="loopback-proxy-$1" reg="${2:-$(registry_flag)}"
  reuse_or_remove "$name" && return 0
  docker create --name "$name" --network "loopback-$role-net" --network-alias proxy \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 256m \
    -e LOOPBACK_PROXY_ROLE="$role" \
    -e LOOPBACK_FIXER_REGISTRY="$([ "$role" = fixer ] && echo "$reg" || echo 0)" \
    "$PROXY_IMG" >/dev/null
  docker network connect "$EGRESS_NET" "$name" || { docker rm -f "$name" >/dev/null; die "could not attach $name to $EGRESS_NET"; }
  docker start "$name" >/dev/null
}

safe_env_file() { # path -> 0 if present and safe, 1 if absent; exits on an unsafe file
  local f="$1"
  [ -e "$f" ] || [ -L "$f" ] || return 1
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f is not a regular file"
  [ "$(stat -c '%u' -- "$f")" = "$(id -u)" ] || die "$f is not owned by you"
  [ "$(stat -c '%a' -- "$f")" = 600 ] || die "$f must have mode 600"
  # Also a bare `GITHUB_TOKEN` line, which docker would fill from this shell's environment.
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?GITHUB_TOKEN([[:space:]]*=|[[:space:]]*$)' -- "$f"; then die "$f sets GITHUB_TOKEN; use only the role's GH_TOKEN"; fi
  return 0
}

start_agent() { # role
  local role="$1" uid name="loopback-$1"
  uid="$(role_uid "$role")"
  reuse_or_remove "$name" && return 0
  local -a extra=()
  if safe_env_file "$CRED_DIR/$role.env"; then extra=(--env-file "$CRED_DIR/$role.env"); fi
  docker run -d --name "$name" --hostname "$role" --network "loopback-$role-net" \
    --user "$uid:$uid" \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 512 --memory 4g --cpus 2 \
    -v "loopback-$role-home:/home/$role" \
    -e HOME="/home/$role" -e LOOPBACK_AGENT_ROLE="$role" \
    -e HTTPS_PROXY="http://proxy:3128" -e https_proxy="http://proxy:3128" \
    -e HTTP_PROXY="http://proxy:3128" -e http_proxy="http://proxy:3128" \
    -e NO_PROXY= -e no_proxy= \
    "${extra[@]}" \
    "$AGENT_IMG" >/dev/null
}

up() {
  ensure_network "$EGRESS_NET" false
  for role in "${ROLES[@]}"; do ensure_network "loopback-$role-net" true; done
  for role in "${ROLES[@]}"; do start_proxy "$role"; start_agent "$role"; done
  status
}

down() {
  for c in loopback-fixer loopback-verifier loopback-proxy-fixer loopback-proxy-verifier; do
    if exists container "$c"; then docker rm -f "$c" >/dev/null; fi
  done
  echo "containers removed (volumes loopback-fixer-home and loopback-verifier-home kept)"
}

status() {
  docker ps -a --filter name=loopback- --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'
  echo "fixer registry access: $([ "$(registry_flag)" = 1 ] && echo on || echo off)"
}

verify() {
  local rc=0 r want got
  for c in loopback-fixer loopback-verifier loopback-proxy-fixer loopback-proxy-verifier; do
    is_running "$c" || die "$c is not running; run '$0 up' first"
  done
  # The in-container checker is the copy baked into the image; refuse a stale image.
  want="$(sha256sum "$REPO/scripts/verify-isolation.mjs" | cut -d' ' -f1)"
  for role in "${ROLES[@]}"; do
    got="$(docker exec "loopback-$role" sha256sum /opt/loopback/verify-isolation.mjs | cut -d' ' -f1)"
    [ "$got" = "$want" ] || die "loopback-$role carries an outdated verify-isolation.mjs; run '$0 build', '$0 down', '$0 up'"
  done
  node "$REPO/scripts/verify-isolation.mjs" host || { r=$?; [ "$r" -gt "$rc" ] && rc=$r; }
  for role in "${ROLES[@]}"; do
    docker exec "loopback-$role" node /opt/loopback/verify-isolation.mjs "$role" || { r=$?; [ "$r" -gt "$rc" ] && rc=$r; }
  done
  return "$rc"
}

registry() { # on|off
  local flag
  case "${1:-}" in on) flag=1 ;; off) flag=0 ;; *) die "usage: $0 registry on|off" ;; esac
  if exists container loopback-proxy-fixer; then
    docker rm -f loopback-proxy-fixer >/dev/null
    start_proxy fixer "$flag"
  fi
  mkdir -p "$STATE_DIR"
  echo "$flag" >"$STATE_DIR/fixer-registry"   # recorded only after the proxy took the setting
  echo "fixer registry access: ${1}"
}

verifier_keygen() {
  is_running loopback-verifier || die "loopback-verifier is not running; run '$0 up' first"
  # Runs as the verifier (uid 10002) inside its container; refuses to overwrite an existing key.
  docker exec -i loopback-verifier node --input-type=module -e '
    import { generateKeyPairSync } from "node:crypto";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const dir = join(process.env.HOME, ".config", "loopback-verifier");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "signing-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
  ' || die "key generation failed (an existing key is never overwritten)"
  echo "Put this PUBLIC key in the gate's VERIFIER_PUBLIC_KEY (owner step; never the private key)."
}

case "${1:-}" in
  build)
    docker build -t "$PROXY_IMG" "$HERE/proxy"
    docker build -t "$AGENT_IMG" -f "$HERE/agent/Dockerfile" "$REPO" ;;
  up) up ;;
  down) down ;;
  status) status ;;
  verify) verify ;;
  registry) registry "${2:-}" ;;
  verifier-keygen) verifier_keygen ;;
  *) echo "usage: $0 build|up|down|status|verify|registry on|off|verifier-keygen" >&2; exit 2 ;;
esac
