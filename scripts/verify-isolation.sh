#!/usr/bin/env bash
# Read-only isolation evidence for D28. Run it once AS EACH identity, after the identities and
# their credentials exist (it creates nothing):
#
#   sudo -u loopback-verifier -H scripts/verify-isolation.sh verifier
#   sudo -u loopback-fixer    -H scripts/verify-isolation.sh fixer
#   sudo -u loopback-gate     -H scripts/verify-isolation.sh gate
#
# Paths of the OTHER identities' credentials come from the environment (defaults shown):
#   LOOPBACK_GATE_HOME=/home/loopback-gate         LOOPBACK_GATE_KEY=$LOOPBACK_GATE_HOME/loopback/secrets/gate.pem
#   LOOPBACK_GATE_ENV=$LOOPBACK_GATE_HOME/loopback/.env
#   LOOPBACK_FIXER_HOME=/home/loopback-fixer       LOOPBACK_VERIFIER_HOME=/home/loopback-verifier
#   LOOPBACK_VERIFIER_KEY=$LOOPBACK_VERIFIER_HOME/.config/loopback-verifier/signing-key.pem
#   GH_REPO=owner/repo (verifier only: one read-only GET to show read access)
#
# What it does: prints uid/groups and home ownership/mode, attempts to READ the other
# identities' credential files (each attempt must fail), reports whether GH_TOKEN is set (never
# its value) and whether a git credential helper is configured, and for the verifier makes one
# read-only GitHub GET. It never prints file contents, tokens or keys, never writes anything,
# and makes no write requests. Write-permission probes are a separate, manually authorised step.
#
# Passing proves only what it checks, at the moment it runs. It does not by itself set
# VERIFIER_ISOLATION_PROVEN; record the output and decide.
set -u
umask 077

role="${1:-}"
case "$role" in gate|fixer|verifier) ;; *) echo "usage: $0 gate|fixer|verifier" >&2; exit 2 ;; esac

GATE_HOME="${LOOPBACK_GATE_HOME:-/home/loopback-gate}"
FIXER_HOME="${LOOPBACK_FIXER_HOME:-/home/loopback-fixer}"
VERIFIER_HOME="${LOOPBACK_VERIFIER_HOME:-/home/loopback-verifier}"
GATE_KEY="${LOOPBACK_GATE_KEY:-$GATE_HOME/loopback/secrets/gate.pem}"
GATE_ENV="${LOOPBACK_GATE_ENV:-$GATE_HOME/loopback/.env}"
VERIFIER_KEY="${LOOPBACK_VERIFIER_KEY:-$VERIFIER_HOME/.config/loopback-verifier/signing-key.pem}"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
info() { printf 'INFO  %s\n' "$1"; }

# A read attempt that discards whatever it reads; only success or failure is reported.
must_not_read() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then
    if ls -A -- "$path" >/dev/null 2>&1; then bad "$label is listable: $path"; else pass "$label is not listable"; fi
  elif cat -- "$path" >/dev/null 2>&1; then
    bad "$label is readable: $path"
  elif [ -e "$path" ] || [ -L "$path" ]; then
    pass "$label exists but cannot be read"
  else
    # A missing path proves nothing: the evidence must come from a real denied read.
    bad "$label not found at $path (cannot prove it is unreadable; fix the path)"
  fi
}

echo "== identity ($role)"
info "user=$(id -un) uid=$(id -u) groups=$(id -Gn | tr ' ' ',')"
home="${HOME:-}"
if [ -n "$home" ] && [ -d "$home" ]; then
  info "home=$home owner=$(stat -c '%U' -- "$home") mode=$(stat -c '%a' -- "$home")"
  mode="$(stat -c '%a' -- "$home")"
  case "$mode" in *00) pass "home is not accessible to group/others" ;; *) bad "home mode $mode allows group/other access (want 700)" ;; esac
  [ "$(stat -c '%u' -- "$home")" = "$(id -u)" ] && pass "home is owned by this user" || bad "home is not owned by this user"
else
  bad "HOME is unset or missing"
fi

echo "== cross-identity credential reads (each must fail)"
for other in gate fixer verifier; do
  [ "$other" = "$role" ] && continue
  case "$other" in
    gate)
      must_not_read "gate home" "$GATE_HOME"
      must_not_read "gate private key" "$GATE_KEY"
      must_not_read "gate .env" "$GATE_ENV" ;;
    fixer)
      must_not_read "fixer home" "$FIXER_HOME"
      must_not_read "fixer gh config" "$FIXER_HOME/.config/gh/hosts.yml"
      must_not_read "fixer Claude settings" "$FIXER_HOME/.claude" ;;
    verifier)
      must_not_read "verifier home" "$VERIFIER_HOME"
      must_not_read "verifier signing key" "$VERIFIER_KEY"
      must_not_read "verifier gh config" "$VERIFIER_HOME/.config/gh/hosts.yml" ;;
  esac
done
if [ "$role" = "fixer" ]; then
  if cat -- "$GATE_KEY" >/dev/null 2>&1; then
    bad "the fixer can read the gate's GitHub App private key"
  elif [ -e "$GATE_KEY" ] || [ -L "$GATE_KEY" ]; then
    pass "the fixer cannot read the gate's GitHub App private key"
  else
    bad "gate private key not found at $GATE_KEY (cannot prove the fixer is denied)"
  fi
fi

echo "== git and GitHub credentials"
if [ -n "${GH_TOKEN:-}" ]; then info "GH_TOKEN is set (value not shown)"; else info "GH_TOKEN is empty"; fi
if [ -n "${GITHUB_TOKEN:-}" ]; then info "GITHUB_TOKEN is set (value not shown)"; fi
helpers="$(git config --get-all credential.helper 2>/dev/null || true)"
if [ -n "$helpers" ]; then info "a git credential helper is configured ($(printf '%s' "$helpers" | wc -l | tr -d ' ') entr(y/ies); names not shown)"; else info "no git credential helper is configured"; fi
if [ "$role" = "verifier" ]; then
  [ -z "$helpers" ] && pass "verifier has no git credential helper (cannot push)" || bad "verifier has a git credential helper configured"
  if [ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ] && command -v curl >/dev/null 2>&1; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${GH_TOKEN}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${GH_REPO}" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && pass "verifier token can read $GH_REPO (GET 200)" || bad "verifier token read of $GH_REPO returned $code"
    info "write permissions are NOT tested here; run the separately authorised probes"
  else
    info "skipped the read check (needs GH_TOKEN, GH_REPO and curl)"
  fi
fi

echo "== summary"
if [ "$failures" -eq 0 ]; then echo "no failures for role $role"; else echo "$failures failure(s) for role $role"; fi
[ "$failures" -eq 0 ]
