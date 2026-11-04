#!/usr/bin/env bash
# READ-ONLY check of the live GitHub setup, run by a maintainer with their own `gh` login.
#   GH_REPO=owner/fork RULESET_ID=<id> TAG_RULESET_ID=<id> DEMO_RESET_SHA=<sha> scripts/verify-github-setup.sh
# Reports PASS/FAIL per check; changes nothing.
set -uo pipefail
: "${GH_REPO:?}" "${RULESET_ID:?}" "${TAG_RULESET_ID:?}" "${DEMO_RESET_SHA:?}"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
rs="$(gh api "repos/$GH_REPO/rulesets/$RULESET_ID" 2>/dev/null)"
trs="$(gh api "repos/$GH_REPO/rulesets/$TAG_RULESET_ID" 2>/dev/null)"
check "branch ruleset readable"            '[ -n "$rs" ]'
check "branch ruleset enforcement active"  'jq -e ".enforcement == \"active\"" <<<"$rs"'
check "branch ruleset bypass list empty"   'jq -e "(.bypass_actors // []) | length == 0" <<<"$rs"'
check "branch ruleset targets demo/*"      'jq -e ".conditions.ref_name.include | index(\"refs/heads/demo/*\") != null" <<<"$rs"'
for ctx in test loopback/gate; do
  check "requires status check $ctx"       "jq -e '[.rules[] | select(.type == \"required_status_checks\") | .parameters.required_status_checks[].context] | index(\"$ctx\") != null' <<<\"\$rs\""
done
check "loopback/gate pinned to an App"     'jq -e "[.rules[] | select(.type == \"required_status_checks\") | .parameters.required_status_checks[] | select(.context == \"loopback/gate\") | .integration_id] | .[0] != null" <<<"$rs"'
check "requires up-to-date branches"       'jq -e "[.rules[] | select(.type == \"required_status_checks\") | .parameters.strict_required_status_checks_policy] | index(true) != null" <<<"$rs"'
for rule in pull_request non_fast_forward deletion; do
  check "branch rule $rule present"         "jq -e '[.rules[].type] | index(\"$rule\") != null' <<<\"\$rs\""
done
check "tag ruleset active, targets demo-reset" 'jq -e ".enforcement == \"active\" and (.conditions.ref_name.include | index(\"refs/tags/demo-reset\") != null)" <<<"$trs"'
check "demo-reset tag points at DEMO_RESET_SHA" '[ "$(gh api "repos/$GH_REPO/git/ref/tags/demo-reset" --jq .object.sha)" = "$DEMO_RESET_SHA" ]'
check "DEMO_RESET_SHA exists"              'gh api "repos/$GH_REPO/commits/$DEMO_RESET_SHA" --jq .sha'
exit $fail
