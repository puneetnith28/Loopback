#!/usr/bin/env bash
# Agent-runtime containers on the Loopback rootless daemon (D28, D29, step 6.4).
#
#   deploy/isolation/agents.sh build              build the egress-proxy and agent images
#   deploy/isolation/agents.sh signer-init        create the signer's key and client token inside the
#                                                 signer volume; prints only the PUBLIC key
#   deploy/isolation/agents.sh up                 networks, proxies, fixer, verifier, signer, runner
#   deploy/isolation/agents.sh signer-token       hand the signer client token to the verifier
#                                                 (signer volume -> pipe -> verifier volume; never printed)
#   deploy/isolation/agents.sh signer-rotate-token replace the client token (key kept), restart the
#                                                 signer, hand the new token to the verifier
#   deploy/isolation/agents.sh recycle-verifier   fresh verifier container AND home volume (run it
#                                                 before each verification run: nothing an earlier
#                                                 session planted survives), then a new token hand-off
#   deploy/isolation/agents.sh down               remove the containers (volumes are kept)
#   deploy/isolation/agents.sh status             list the containers
#   deploy/isolation/agents.sh verify             verify-isolation.mjs: host, then inside every container
#   deploy/isolation/agents.sh registry on|off    allow / stop the fixer's npm registry access
#
# Credentials (owner files under $CRED_DIR, default ~/.config/loopback-agents, each a regular file
# owned by you with mode 600):
#   fixer.env, verifier.env  that role's GH_TOKEN (verifier: read-only), GH_REPO, Switch/model creds
#   signer.env               SIGNER_REPOSITORY=owner/name, SIGNER_ISSUER_PUBLIC_KEY=<the gate's run-issuer
#                            PUBLIC key, raw 32-byte base64>, optional SIGNER_GH_TOKEN (read-only)
# GITHUB_TOKEN is refused everywhere. Nothing here prints a credential or a private key.
#
# Topology (all agent networks --internal: no route out):
#   loopback-fixer-net         fixer + loopback-proxy-fixer
#   loopback-verifier-net      verifier + loopback-proxy-verifier
#   loopback-signer-net        verifier + signer            (the only way to the signer)
#   loopback-signer-egress-net signer + loopback-proxy-signer (api.github.com only)
#   loopback-egress            the three proxies (routed)
#   runner                     --network none; jobs volume read-only, results volume read-write
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CRED_DIR="${LOOPBACK_AGENT_CRED_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/loopback-agents}"
STATE_DIR="${LOOPBACK_DOCKER_RUN_DIR:-${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/loopback-docker}"
PROXY_IMG=loopback-egress-proxy:local
AGENT_IMG=loopback-agent:local
EGRESS_NET=loopback-egress
SIGNER_MAIN=/opt/loopback-app/apps/switch-gate/dist/signer/main.js
CONTAINERS=(loopback-fixer loopback-verifier loopback-signer loopback-runner loopback-proxy-fixer loopback-proxy-verifier loopback-proxy-signer)

die() { echo "agents: $*" >&2; exit 1; }

DOCKER_HOST="$("$HERE/rootless-docker.sh" env)"; DOCKER_HOST="${DOCKER_HOST#DOCKER_HOST=}"; export DOCKER_HOST
"$HERE/rootless-docker.sh" status >/dev/null || die "the Loopback rootless daemon is not running; start it with $HERE/rootless-docker.sh start"

role_uid() { case "$1" in fixer) echo 10001 ;; verifier) echo 10002 ;; signer) echo 10003 ;; runner) echo 10004 ;; esac; }
HARDEN=(--read-only --cap-drop ALL --security-opt no-new-privileges)

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

# An existing container is reused only if running; a stopped or half-created one is replaced.
reuse_or_remove() {
  exists container "$1" || return 1
  is_running "$1" && return 0
  docker rm -f "$1" >/dev/null
  return 1
}

start_proxy() { # role internal-network [registry-flag]
  local role="$1" net="$2" name="loopback-proxy-$1" reg="${3:-$(registry_flag)}"
  reuse_or_remove "$name" && return 0
  docker create --name "$name" --network "$net" --network-alias proxy \
    "${HARDEN[@]}" --tmpfs /tmp:rw,nosuid,nodev,size=64m --pids-limit 256 --memory 256m \
    -e LOOPBACK_PROXY_ROLE="$role" \
    -e LOOPBACK_FIXER_REGISTRY="$([ "$role" = fixer ] && echo "$reg" || echo 0)" \
    "$PROXY_IMG" >/dev/null
  docker network connect "$EGRESS_NET" "$name" || { docker rm -f "$name" >/dev/null; die "could not attach $name to $EGRESS_NET"; }
  docker start "$name" >/dev/null
}

safe_env_file() { # path [allowed-keys-regex] -> 0 if present and safe, 1 if absent; exits otherwise
  local f="$1" allowed="${2:-}"
  [ -e "$f" ] || [ -L "$f" ] || return 1
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f is not a regular file"
  [ "$(stat -c '%u' -- "$f")" = "$(id -u)" ] || die "$f is not owned by you"
  [ "$(stat -c '%a' -- "$f")" = 600 ] || die "$f must have mode 600"
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?GITHUB_TOKEN([[:space:]]*=|[[:space:]]*$)' -- "$f"; then die "$f sets GITHUB_TOKEN; use only the role's GH_TOKEN"; fi
  if [ -n "$allowed" ] && grep -vE '^[[:space:]]*(#|$)' -- "$f" | grep -qvE "^($allowed)="; then die "$f may set only: ${allowed//|/, }"; fi
  return 0
}

start_agent() { # fixer|verifier
  local role="$1" uid name="loopback-$1"
  uid="$(role_uid "$role")"
  reuse_or_remove "$name" && return 0
  local -a extra=()
  if safe_env_file "$CRED_DIR/$role.env"; then extra+=(--env-file "$CRED_DIR/$role.env"); fi
  if [ "$role" = verifier ]; then
    extra+=(-v loopback-runner-jobs:/jobs -v loopback-runner-results:/results:ro)
  fi
  docker create --name "$name" --hostname "$role" --network "loopback-$role-net" \
    --user "$uid:$uid" "${HARDEN[@]}" --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --pids-limit 512 --memory 4g --cpus 2 \
    -v "loopback-$role-home:/home/$role" \
    -e HOME="/home/$role" -e LOOPBACK_AGENT_ROLE="$role" \
    -e HTTPS_PROXY="http://proxy:3128" -e https_proxy="http://proxy:3128" \
    -e HTTP_PROXY="http://proxy:3128" -e http_proxy="http://proxy:3128" \
    -e NO_PROXY= -e no_proxy= \
    "${extra[@]}" "$AGENT_IMG" >/dev/null
  if [ "$role" = verifier ]; then
    docker network connect loopback-signer-net "$name" || { docker rm -f "$name" >/dev/null; die "could not attach $name to loopback-signer-net"; }
  fi
  docker start "$name" >/dev/null
}

signer_initialized() {
  docker run --rm --network none --user 10003:10003 "${HARDEN[@]}" -e SIGNER_HOME=/home/signer \
    -v loopback-signer-home:/home/signer "$AGENT_IMG" node "$SIGNER_MAIN" public-key >/dev/null 2>&1
}

start_signer() {
  local name=loopback-signer
  reuse_or_remove "$name" && return 0
  if ! signer_initialized; then echo "agents: signer not initialized; run '$0 signer-init' (signer not started)" >&2; return 0; fi
  safe_env_file "$CRED_DIR/signer.env" "SIGNER_REPOSITORY|SIGNER_ISSUER_PUBLIC_KEY|SIGNER_GH_TOKEN" \
    || { echo "agents: $CRED_DIR/signer.env is missing (SIGNER_REPOSITORY, SIGNER_ISSUER_PUBLIC_KEY); signer not started" >&2; return 0; }
  docker create --name "$name" --hostname signer --network loopback-signer-net --network-alias signer \
    --user 10003:10003 "${HARDEN[@]}" --pids-limit 128 --memory 256m --cpus 1 \
    -v loopback-signer-home:/home/signer \
    -e SIGNER_HOME=/home/signer -e LOOPBACK_AGENT_ROLE=signer -e HTTPS_PROXY="http://proxy:3128" \
    --env-file "$CRED_DIR/signer.env" \
    "$AGENT_IMG" node "$SIGNER_MAIN" serve >/dev/null
  docker network connect loopback-signer-egress-net "$name" || { docker rm -f "$name" >/dev/null; die "could not attach the signer to loopback-signer-egress-net"; }
  docker start "$name" >/dev/null
}

start_runner() {
  local name=loopback-runner
  reuse_or_remove "$name" && return 0
  docker run -d --name "$name" --hostname runner --network none \
    --user 10004:10004 "${HARDEN[@]}" --tmpfs /work:rw,nosuid,nodev,size=1g \
    --pids-limit 512 --memory 2g --cpus 2 \
    -v loopback-runner-jobs:/jobs:ro -v loopback-runner-results:/results \
    -e HOME=/work -e LOOPBACK_AGENT_ROLE=runner \
    "$AGENT_IMG" node /opt/loopback/sandbox-runner.mjs >/dev/null
}

up() {
  ensure_network "$EGRESS_NET" false
  for net in loopback-fixer-net loopback-verifier-net loopback-signer-net loopback-signer-egress-net; do ensure_network "$net" true; done
  start_proxy fixer loopback-fixer-net
  start_proxy verifier loopback-verifier-net
  start_proxy signer loopback-signer-egress-net
  start_runner          # first: initializes the results volume with the runner's ownership
  start_agent verifier  # initializes the jobs volume with the verifier's ownership
  start_agent fixer
  start_signer
  status
}

down() {
  for c in "${CONTAINERS[@]}"; do if exists container "$c"; then docker rm -f "$c" >/dev/null; fi; done
  echo "containers removed (volumes kept)"
}

status() {
  docker ps -a --filter name=loopback- --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'
  echo "fixer registry access: $([ "$(registry_flag)" = 1 ] && echo on || echo off)"
}

signer_init() {
  docker run --rm --network none --user 10003:10003 "${HARDEN[@]}" -e SIGNER_HOME=/home/signer \
    -v loopback-signer-home:/home/signer "$AGENT_IMG" node "$SIGNER_MAIN" init \
    || die "signer init failed (an existing key or token is never overwritten)"
  echo "Put this PUBLIC key in the gate's VERIFIER_PUBLIC_KEY (owner step). Then: '$0 up' and '$0 signer-token'."
}

signer_token() {
  is_running loopback-verifier || die "loopback-verifier is not running; run '$0 up' first"
  # Signer volume -> pipe -> verifier volume. The token never touches the host disk or terminal.
  docker run --rm --network none --user 10003:10003 "${HARDEN[@]}" -e SIGNER_HOME=/home/signer \
    -v loopback-signer-home:/home/signer "$AGENT_IMG" node "$SIGNER_MAIN" export-client-token \
  | docker exec -i loopback-verifier node --input-type=module -e '
      import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const token = readFileSync(0, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(token)) { process.stderr.write("no valid token received\n"); process.exit(1); }
      const dir = join(process.env.HOME, ".config", "loopback-verifier");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "signer-token"), token, { mode: 0o600 });
      chmodSync(join(dir, "signer-token"), 0o600);
      // D29: a verifier never holds a signing key; remove one left by the D28 layout.
      rmSync(join(dir, "signing-key.pem"), { force: true });
    ' || die "could not hand the token to the verifier"
  echo "signer client token installed in the verifier (not shown)"
}

signer_rotate_token() {
  docker run --rm --network none --user 10003:10003 "${HARDEN[@]}" -e SIGNER_HOME=/home/signer \
    -v loopback-signer-home:/home/signer "$AGENT_IMG" node "$SIGNER_MAIN" rotate-token || die "token rotation failed"
  if exists container loopback-signer; then docker rm -f loopback-signer >/dev/null; fi
  start_signer
  signer_token
}

recycle_verifier() {
  if exists container loopback-verifier; then docker rm -f loopback-verifier >/dev/null; fi
  if exists volume loopback-verifier-home; then docker volume rm loopback-verifier-home >/dev/null; fi
  start_agent verifier
  signer_token
  echo "verifier recycled: fresh container and home volume, new token hand-off (the token itself is unchanged; rotate it with signer-rotate-token)"
}

verify() {
  local rc=0 r want got
  for c in "${CONTAINERS[@]}"; do is_running "$c" || die "$c is not running; run '$0 up' (and '$0 signer-init') first"; done
  # The in-container checker is the copy baked into the image; refuse a stale image.
  want="$(sha256sum "$REPO/scripts/verify-isolation.mjs" | cut -d' ' -f1)"
  for c in loopback-fixer loopback-verifier loopback-signer loopback-runner; do
    got="$(docker exec "$c" sha256sum /opt/loopback/verify-isolation.mjs | cut -d' ' -f1)"
    [ "$got" = "$want" ] || die "$c carries an outdated verify-isolation.mjs; run '$0 build', '$0 down', '$0 up'"
  done
  node "$REPO/scripts/verify-isolation.mjs" host || { r=$?; [ "$r" -gt "$rc" ] && rc=$r; }
  for role in fixer verifier signer runner; do
    docker exec "loopback-$role" node /opt/loopback/verify-isolation.mjs "$role" || { r=$?; [ "$r" -gt "$rc" ] && rc=$r; }
  done
  return "$rc"
}

registry() { # on|off
  local flag
  case "${1:-}" in on) flag=1 ;; off) flag=0 ;; *) die "usage: $0 registry on|off" ;; esac
  if exists container loopback-proxy-fixer; then
    docker rm -f loopback-proxy-fixer >/dev/null
    start_proxy fixer loopback-fixer-net "$flag"
  fi
  mkdir -p "$STATE_DIR"
  echo "$flag" >"$STATE_DIR/fixer-registry"   # recorded only after the proxy took the setting
  echo "fixer registry access: ${1}"
}

case "${1:-}" in
  build)
    docker build -t "$PROXY_IMG" "$HERE/proxy"
    docker build -t "$AGENT_IMG" -f "$HERE/agent/Dockerfile" "$REPO" ;;
  signer-init) signer_init ;;
  signer-token) signer_token ;;
  signer-rotate-token) signer_rotate_token ;;
  recycle-verifier) recycle_verifier ;;
  up) up ;;
  down) down ;;
  status) status ;;
  verify) verify ;;
  registry) registry "${2:-}" ;;
  *) echo "usage: $0 build|signer-init|up|signer-token|signer-rotate-token|recycle-verifier|down|status|verify|registry on|off" >&2; exit 2 ;;
esac
