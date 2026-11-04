#!/usr/bin/env bash
# Session-only rootless Docker daemon for Loopback's fixer and verifier containers (D28, step 6.4).
#
# Separate from every other Docker on the host: its own data, exec, pid and socket paths under
# $XDG_RUNTIME_DIR/loopback-docker and $XDG_DATA_HOME/loopback-docker. It installs no systemd unit,
# enables no linger, switches no docker context, edits no shell profile and never touches the
# rootful daemon at /var/run/docker.sock. Run `stop` before logging out: with logind's default
# KillUserProcesses=no the daemon would outlive the session after its socket directory is removed.
#
#   deploy/isolation/rootless-docker.sh start    start the daemon (no-op if already running)
#   deploy/isolation/rootless-docker.sh status   exit 0 if running and rootless
#   deploy/isolation/rootless-docker.sh env      print the DOCKER_HOST line to use per command
#   deploy/isolation/rootless-docker.sh stop     stop it (data is kept; delete DATA_DIR to discard)
#
# Networking: slirp4netns with --disable-host-loopback, so containers cannot reach the host's
# 127.0.0.1 services. LAN and metadata addresses are blocked by the egress proxy and the
# internal-only networks (see deploy/isolation/README.md); this daemon alone does not block them.
# --icc=false is not used: it needs the br_netfilter module, which only root can load. Fixer and
# verifier instead sit on separate internal networks, so they share no bridge.
set -euo pipefail
umask 077

: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set (use a normal login session)}"
RUN_DIR="${LOOPBACK_DOCKER_RUN_DIR:-$XDG_RUNTIME_DIR/loopback-docker}"
DATA_DIR="${LOOPBACK_DOCKER_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/loopback-docker}"
SOCK="$RUN_DIR/docker.sock"
KIT_PID="$RUN_DIR/rootlesskit.pid"
LOG="$RUN_DIR/dockerd.log"
START_TIMEOUT_S=60

die() { echo "rootless-docker: $*" >&2; exit 1; }
dk() { DOCKER_HOST="unix://$SOCK" docker "$@"; }

# Running = the recorded pid is alive AND is rootlesskit (a reused pid is never signalled).
running() {
  [ -f "$KIT_PID" ] || return 1
  local pid; pid="$(cat -- "$KIT_PID")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = rootlesskit ]
}

rootless_ok() {
  dk info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=rootless'
}

require() {
  local missing=""
  for b in rootlesskit slirp4netns dockerd containerd runc newuidmap newgidmap docker; do
    command -v "$b" >/dev/null 2>&1 || missing="$missing $b"
  done
  [ -z "$missing" ] || die "missing binaries:$missing"
  grep -q "^$(id -un):" /etc/subuid || die "no /etc/subuid range for $(id -un)"
  grep -q "^$(id -un):" /etc/subgid || die "no /etc/subgid range for $(id -un)"
  [ "$(id -u)" != 0 ] || die "run as your normal user, not root"
}

start() {
  if running; then echo "already running (DOCKER_HOST=unix://$SOCK)"; return 0; fi
  require
  mkdir -p "$RUN_DIR" "$DATA_DIR"
  chmod 700 "$RUN_DIR" "$DATA_DIR"
  rm -f -- "$SOCK" "$KIT_PID"
  # The child runs inside rootlesskit's user/mount/network namespaces. As dockerd-rootless.sh
  # does, drop the parent's /run/docker links so the child creates its own.
  XDG_RUNTIME_DIR="$RUN_DIR" XDG_CONFIG_HOME="$RUN_DIR/config" setsid rootlesskit \
    --state-dir="$RUN_DIR/rootlesskit" \
    --net=slirp4netns --mtu=65520 \
    --slirp4netns-sandbox=auto --slirp4netns-seccomp=auto \
    --disable-host-loopback \
    --port-driver=builtin \
    --copy-up=/etc --copy-up=/run \
    --propagation=rslave \
    bash -c 'rm -f /run/docker /run/containerd /run/xtables.lock; exec dockerd "$@"' dockerd \
      --data-root="$DATA_DIR" \
      --exec-root="$RUN_DIR/exec" \
      --pidfile="$RUN_DIR/dockerd.pid" \
      --host="unix://$SOCK" \
      --no-new-privileges \
    >"$LOG" 2>&1 </dev/null &
  echo $! >"$KIT_PID"
  local waited=0
  until dk info >/dev/null 2>&1; do
    running || die "daemon exited during start-up; see $LOG"
    [ "$waited" -lt "$START_TIMEOUT_S" ] || { stop; die "daemon not ready after ${START_TIMEOUT_S}s; see $LOG"; }
    sleep 1; waited=$((waited + 1))
  done
  rootless_ok || { stop; die "daemon is not running rootless; stopped it"; }
  echo "started rootless daemon (DOCKER_HOST=unix://$SOCK)"
}

stop() {
  if ! running; then rm -f -- "$KIT_PID"; echo "not running"; return 0; fi
  local pid; pid="$(cat -- "$KIT_PID")"
  # setsid made rootlesskit a process-group leader: signal the whole group (dockerd, containerd,
  # slirp4netns) so nothing is orphaned if the grace period runs out.
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  rm -f -- "$KIT_PID" "$SOCK"
  echo "stopped"
}

status() {
  if running && rootless_ok; then echo "running, rootless (DOCKER_HOST=unix://$SOCK)"; return 0; fi
  echo "not running"; return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  env) echo "DOCKER_HOST=unix://$SOCK" ;;
  *) echo "usage: $0 start|stop|status|env" >&2; exit 2 ;;
esac
