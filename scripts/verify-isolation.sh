#!/usr/bin/env bash
# Read-only isolation evidence for D28 on the Switch agent controller's separate-users
# runtime (switch-agent-controller 0.31.0 `install-service --separate-users`). It creates,
# changes and sends nothing, never prints file contents, tokens or keys, and makes no
# GitHub write requests (write-permission probes are a separate, manually authorised step).
#
#   gate      run as the controller's user (your desktop user), outside any sandbox:
#               scripts/verify-isolation.sh gate
#   fixer     run INSIDE the fixer's agent unit (e.g. ask the fixer agent to run it, or
#   verifier  `systemd-run` with the unit's properties); outside it the checks prove nothing
#             and the script refuses with exit code 2.
#
# Environment (defaults shown):
#   LOOPBACK_CONTROLLER_UID   uid of the controller's user           (id -u for `gate`; required inside agents)
#   LOOPBACK_GATE_KEY         the gate's App key                      ($HOME/Hacktoberfest/Loopback/secrets/gate.pem for `gate`)
#   LOOPBACK_GATE_ENV         the gate's .env                         (beside the key's parent directory)
#   LOOPBACK_SIGNER_DIR       root-owned signing helper directory     (/usr/local/lib/loopback-signer)
#   GH_REPO                   owner/repo for the verifier's read-only GET
#   LOOPBACK_SU_CONFIG_DIR, LOOPBACK_AGENTS_PARENT   test overrides of /etc/switch-agent-controller, /var/lib/switch-agents
#
# Exit codes: 0 every check for this role passed; 1 at least one failed; 2 the proof cannot
# be executed here (runtime not installed, not inside the sandbox, bad usage).
# Passing proves only what this role's checks show at this moment. Isolation is demonstrated
# only when all three roles pass (fixer and verifier inside their units), the verifier token's
# write probes are refused, and a live signed report is accepted while a forged one is
# rejected. This script never sets VERIFIER_ISOLATION_PROVEN.
set -u
umask 077

role="${1:-}"
case "$role" in gate|fixer|verifier) ;; *) echo "usage: $0 gate|fixer|verifier" >&2; exit 2 ;; esac

SU_CONFIG_DIR="${LOOPBACK_SU_CONFIG_DIR:-/etc/switch-agent-controller}"
AGENTS_PARENT="${LOOPBACK_AGENTS_PARENT:-/var/lib/switch-agents}"
SIGNER_DIR="${LOOPBACK_SIGNER_DIR:-/usr/local/lib/loopback-signer}"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
info() { printf 'INFO  %s\n' "$1"; }
cannot() { printf 'CANNOT RUN  %s\n' "$1"; echo "== verdict: NOT PROVEN (the proof could not be executed here)"; exit 2; }

# A read attempt that discards whatever it reads; only success or failure is reported.
readable() { if [ -d "$1" ]; then ls -A -- "$1" >/dev/null 2>&1; else cat -- "$1" >/dev/null 2>&1; fi; }
# /home hidden by ProtectHome=yes (inaccessible, or empty).
home_hidden() { ! ls -A /home >/dev/null 2>&1 || [ -z "$(ls -A /home 2>/dev/null)" ]; }
mode_of() { stat -c '%a' -- "$1"; }
owner_of() { stat -c '%U' -- "$1"; }

echo "== identity ($role)"
info "user=$(id -un) uid=$(id -u) groups=$(id -Gn | tr ' ' ',')"

if [ "$role" = "gate" ]; then
  cuid="${LOOPBACK_CONTROLLER_UID:-$(id -u)}"
  setup="$SU_CONFIG_DIR/separate-users-$cuid.json"
  [ -e "$setup" ] || cannot "the separate-users runtime is not installed for uid $cuid ($setup is missing)"
  agents="$AGENTS_PARENT/$cuid"
  [ -d "$agents" ] || cannot "no agents directory at $agents"
  pass "separate-users setup present ($setup)"
  slots=0
  for d in "$agents"/[0-9][0-9]; do
    [ -d "$d" ] || continue
    slots=$((slots + 1))
    slot="$(basename -- "$d")"
    want="sa$cuid-$slot"
    if [ "$(owner_of "$d")" = "$want" ]; then pass "slot $slot directory owned by $want"; else bad "slot $slot directory is owned by $(owner_of "$d"), not $want"; fi
    case "$(mode_of "$d")" in *0) pass "slot $slot directory is not accessible to others" ;; *) bad "slot $slot directory mode $(mode_of "$d") gives others access" ;; esac
  done
  [ "$slots" -gt 0 ] || bad "no agent slot directories under $agents (no agent has run yet)"
  key="${LOOPBACK_GATE_KEY:-$HOME/Hacktoberfest/Loopback/secrets/gate.pem}"
  if [ -f "$key" ]; then
    case "$(mode_of "$key")" in 600|400) pass "gate key is owner-only" ;; *) bad "gate key mode $(mode_of "$key") is not owner-only" ;; esac
  else
    bad "gate key not found at $key (set LOOPBACK_GATE_KEY)"
  fi
  for f in "$SIGNER_DIR/sign-verifier-report.mjs" "$SIGNER_DIR/signature.js"; do
    if [ -f "$f" ] && [ "$(stat -c '%u' -- "$f")" = 0 ] && [ $(( 0$(mode_of "$f") & 022 )) -eq 0 ]; then pass "$(basename -- "$f") is root-owned and not writable by others"
    else bad "$f is missing, not root-owned, or writable by others"; fi
  done
  info "residual (documented): the controller's user can read what its agents write, including the verifier's signing key"
else
  # Fixer / verifier: these checks only mean something inside the agent unit's sandbox.
  me="$(id -un)"
  [[ "$me" =~ ^sa([0-9]+)-([0-9]{2})$ ]] || cannot "user $me is not a separate-users agent user (sa<uid>-NN); run this inside the $role's agent unit"
  cuid="${LOOPBACK_CONTROLLER_UID:-${BASH_REMATCH[1]}}"
  [ "${SWITCH_HOST_SHARED_GROUP:-}" = "1" ] || cannot "not started by the agent unit (SWITCH_HOST_SHARED_GROUP is not set)"
  case "${HOME:-}" in "$AGENTS_PARENT/$cuid/agent/home") pass "HOME is the agent's own home" ;; *) cannot "HOME=${HOME:-unset} is not $AGENTS_PARENT/$cuid/agent/home; not inside the agent unit" ;; esac
  [ "$(owner_of "$HOME")" = "$me" ] && pass "home is owned by this agent user" || bad "home is not owned by $me"

  echo "== sandbox boundaries"
  if home_hidden; then pass "/home is hidden (ProtectHome)"; else bad "/home is visible from the agent sandbox"; fi
  others="$(ls -A -- "$AGENTS_PARENT/$cuid" 2>/dev/null | grep -vx agent || true)"
  [ -z "$others" ] && pass "no other agent's directory is visible" || bad "other agents' directories are visible: $(echo "$others" | tr '\n' ' ')"
  key="${LOOPBACK_GATE_KEY:-}"
  if [ -n "$key" ] && readable "$key"; then bad "the gate's App key is readable: $key"
  elif [ -n "$key" ] && [ -e "$key" ]; then pass "the gate's App key exists but cannot be read"
  elif home_hidden; then pass "the gate's credentials under /home are hidden by the sandbox"
  else bad "cannot show the gate's credentials are unreadable (set LOOPBACK_GATE_KEY)"; fi
  envf="${LOOPBACK_GATE_ENV:-}"
  if [ -n "$envf" ] && readable "$envf"; then bad "the gate's .env is readable: $envf"; fi

  echo "== git and GitHub credentials"
  if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then info "a GitHub token is set in the environment (value not shown)"; else info "no GitHub token in the environment"; fi
  helpers="$(git config --get-all credential.helper 2>/dev/null || true)"
  [ -z "$helpers" ] && info "no git credential helper" || info "a git credential helper is configured (names not shown)"
  for f in "$SIGNER_DIR/sign-verifier-report.mjs" "$SIGNER_DIR/signature.js"; do
    if [ -f "$f" ] && [ "$(stat -c '%u' -- "$f")" = 0 ] && [ $(( 0$(mode_of "$f") & 022 )) -eq 0 ]; then pass "$(basename -- "$f") is root-owned and not writable by others"
    else bad "$f is missing, not root-owned, or writable by others"; fi
  done

  if [ "$role" = "verifier" ]; then
    [ -z "$helpers" ] && pass "verifier has no git credential helper (cannot push)" || bad "verifier has a git credential helper configured"
    sk="$HOME/.config/loopback-verifier/signing-key.pem"
    if [ -f "$sk" ] && [ "$(owner_of "$sk")" = "$me" ] && [ "$(mode_of "$sk")" = 600 ]; then pass "the signing key is the verifier's own (owner $me, mode 600)"
    else bad "no signing key owned by $me with mode 600 at $sk"; fi
    if [ -n "${GH_REPO:-}" ] && command -v gh >/dev/null 2>&1; then
      if gh api -X GET "repos/$GH_REPO" --jq .full_name >/dev/null 2>&1; then pass "verifier can read $GH_REPO (GET)"; else bad "verifier cannot read $GH_REPO"; fi
      info "write permissions are NOT tested here; run the separately authorised probes"
    else
      bad "cannot show read access (needs GH_REPO and gh)"
    fi
  else
    info "the verifier's directory and signing key are covered by 'no other agent's directory is visible'"
  fi
fi

echo "== summary"
if [ "$failures" -eq 0 ]; then
  echo "every check for role $role passed (one part of the evidence; isolation is not proven by this alone)"
  exit 0
fi
echo "$failures failure(s) for role $role"
echo "== verdict: NOT PROVEN"
exit 1
