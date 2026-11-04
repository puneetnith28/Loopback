#!/usr/bin/env bash
# OWNER STEP (plan 6.3): probe a fixer/verifier fine-grained token WITHOUT printing it.
#
#   scripts/probe-agent-token.sh fixer|verifier                 read probes only (GET)
#   scripts/probe-agent-token.sh fixer|verifier --write-probes  also the separately authorised
#                                                               write-refusal probes (see below)
#
# The token is read from ~/.config/loopback-agents/<role>.env (GH_TOKEN, GH_REPO; mode 600).
# Write probes target things that cannot change state even when permitted:
#   POST /statuses/<all-zero SHA>   403 = no Commit statuses permission (required for both roles);
#                                   422 = permission present (FAIL: the agent could post loopback/gate)
#   PUT  /pulls/999999999/merge     403/404 expected; the PR does not exist, so nothing can merge
#   (verifier only) POST /git/refs with an invalid ref name: 403 = no Contents write (required);
#                                   422 = write permission present (FAIL for the verifier)
set -euo pipefail
role="${1:-}"; mode="${2:-}"
case "$role" in fixer|verifier) ;; *) echo "usage: $0 fixer|verifier [--write-probes]" >&2; exit 2 ;; esac
f="${LOOPBACK_AGENT_CRED_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/loopback-agents}/$role.env"
[ -f "$f" ] && [ ! -L "$f" ] || { echo "missing $f (owner: create it with GH_TOKEN and GH_REPO, mode 600)" >&2; exit 1; }
[ "$(stat -c '%a' -- "$f")" = 600 ] || { echo "$f must have mode 600" >&2; exit 1; }
token="$(sed -n 's/^GH_TOKEN=//p' "$f" | head -1)"; repo="$(sed -n 's/^GH_REPO=//p' "$f" | head -1)"
[ -n "$token" ] && [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "$f must set GH_TOKEN and GH_REPO=owner/repo" >&2; exit 1; }
fail=0
# The token goes to curl on stdin (-K -), never on its command line (visible in the process list).
code() { printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -K - -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Accept: application/vnd.github+json" "$@"; }
expect() { # label actual allowed-codes...
  local label="$1" got="$2"; shift 2
  for c in "$@"; do [ "$got" = "$c" ] && { echo "PASS  $label ($got)"; return; }; done
  echo "FAIL  $label ($got, expected $*)"; fail=1
}
expect "$role token can read $repo" "$(code "https://api.github.com/repos/$repo")" 200
if [ "$mode" = "--write-probes" ]; then
  expect "$role token cannot post commit statuses" "$(code -X POST -d '{"state":"success","context":"loopback/gate"}' "https://api.github.com/repos/$repo/statuses/0000000000000000000000000000000000000000")" 403
  expect "$role token cannot merge (non-existent PR)" "$(code -X PUT -d '{}' "https://api.github.com/repos/$repo/pulls/999999999/merge")" 403 404
  if [ "$role" = verifier ]; then
    expect "verifier token cannot write refs" "$(code -X POST -d '{"ref":"refs/heads/..invalid..","sha":"0000000000000000000000000000000000000000"}' "https://api.github.com/repos/$repo/git/refs")" 403
  fi
else
  echo "INFO  write-refusal probes not run (pass --write-probes once authorised)"
fi
exit "$fail"
