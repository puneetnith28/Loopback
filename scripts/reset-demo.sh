#!/usr/bin/env bash
# Prepare a fresh, protected demo run (decision D17, primary path). Run by a
# maintainer with their own `gh` login; never by an agent.
#
#   GH_REPO=owner/repo DEMO_RESET_SHA=<40-hex> RULESET_ID=<id> scripts/reset-demo.sh
#
# It never changes any ruleset. It:
#   1. checks the target is not the main Loopback project and asks you to type the repo name;
#   2. verifies DEMO_RESET_SHA exists and re-checks the ruleset (active, empty bypass list,
#      targets demo/*, requires `test` and `loopback/gate`) — aborting on any difference;
#   3. closes open loopback/* PRs and deletes loopback/* branches (case branches only);
#   4. creates demo/<yyyymmdd>-<16 random hex> from the recorded SHA (never the mutable
#      demo-reset ref), refusing if that branch already exists;
#   5. archives (never deletes) data/loopback.db and prints the env values for the run.
set -euo pipefail

die() { printf 'reset-demo: %s\n' "$*" >&2; exit 1; }

: "${GH_REPO:?set GH_REPO=owner/repo (e.g. puneetnith28/loopback-demo-target)}"
: "${DEMO_RESET_SHA:?set DEMO_RESET_SHA to the recorded full commit SHA}"
: "${RULESET_ID:?set RULESET_ID to the ruleset protecting demo/*}"
MAIN_REPO="${MAIN_REPO:-puneetnith28/Loopback}"
DB_PATH="${DB_PATH:-./data/loopback.db}"

[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "GH_REPO must be owner/repo"
[[ "$DEMO_RESET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "DEMO_RESET_SHA must be a full lower-case SHA"
[[ "$RULESET_ID" =~ ^[0-9]+$ ]] || die "RULESET_ID must be numeric"
[[ "${GH_REPO,,}" != "${MAIN_REPO,,}" ]] || die "refusing to run demo reset against main Loopback repository $MAIN_REPO"
command -v gh >/dev/null || die "gh CLI is required"
command -v jq >/dev/null || die "jq is required"

printf 'This resets demo state in %s (closes loopback/* PRs, deletes loopback/* branches).\n' "$GH_REPO"
read -r -p "Type the repository name to continue: " answer
[[ "$answer" == "$GH_REPO" ]] || die "confirmation did not match; nothing changed"

# --- 2. preflight: nothing below changes state until all checks pass -------------------
gh api "repos/$GH_REPO/commits/$DEMO_RESET_SHA" --jq .sha >/dev/null || die "DEMO_RESET_SHA not found in $GH_REPO"

ruleset="$(gh api "repos/$GH_REPO/rulesets/$RULESET_ID")" || die "cannot read ruleset $RULESET_ID (needs admin access)"
jq -e '.enforcement == "active"' <<<"$ruleset" >/dev/null || die "ruleset is not active"
jq -e '(.bypass_actors // []) | length == 0' <<<"$ruleset" >/dev/null || die "ruleset bypass list is not empty"
jq -e '.conditions.ref_name.include | index("refs/heads/demo/*") != null' <<<"$ruleset" >/dev/null || die "ruleset does not target demo/*"
for ctx in test loopback/gate; do
  jq -e --arg c "$ctx" '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | index($c) != null' <<<"$ruleset" >/dev/null \
    || die "ruleset does not require status check $ctx"
done
for rule in pull_request non_fast_forward deletion; do
  jq -e --arg r "$rule" '[.rules[].type] | index($r) != null' <<<"$ruleset" >/dev/null || die "ruleset is missing rule $rule"
done
# With this off, GitHub requires passing checks on a branch that does not exist yet, so no run branch
# can ever be created (HTTP 422, "Reference update failed"). Merges into the branch stay checked.
jq -e '[.rules[] | select(.type == "required_status_checks") | .parameters.do_not_enforce_on_create] | index(true) != null' <<<"$ruleset" >/dev/null   || die "ruleset must set do_not_enforce_on_create (\"Do not require status checks on creation\"), or no run branch can be created"

if tag_obj="$(gh api "repos/$GH_REPO/git/ref/tags/demo-reset" --jq '.object.type + " " + .object.sha' 2>/dev/null)"; then
  tag_sha="${tag_obj#* }"
  # An annotated tag's ref names a tag object: peel it to the commit before comparing.
  if [[ "$tag_obj" == "tag "* ]]; then tag_sha="$(gh api "repos/$GH_REPO/git/tags/$tag_sha" --jq .object.sha)"; fi
  [[ "$tag_sha" == "$DEMO_RESET_SHA" ]] || printf 'WARNING: tag demo-reset points to %s, not the recorded SHA; using the recorded SHA.\n' "$tag_sha" >&2
fi

run_id="$(date -u +%Y%m%d)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$run_id" =~ ^[0-9]{8}-[0-9a-f]{16}$ ]] || die "could not generate a run id"
if gh api "repos/$GH_REPO/git/ref/heads/demo/$run_id" >/dev/null 2>&1; then
  die "branch demo/$run_id already exists; refusing to reuse it"
fi

# --- 3. clean up case PRs and branches ---------------------------------------------------
gh pr list --repo "$GH_REPO" --state open --limit 200 --json number,headRefName \
  --jq '.[] | select(.headRefName | startswith("loopback/")) | .number' |
  while read -r pr; do gh pr close "$pr" --repo "$GH_REPO" --comment "Closed by reset-demo." >/dev/null; done

gh api "repos/$GH_REPO/git/matching-refs/heads/loopback/" --jq '.[].ref' |
  while read -r ref; do gh api -X DELETE "repos/$GH_REPO/git/$ref" >/dev/null; done

# --- 4. create the run branch from the recorded SHA ------------------------------------------
gh api -X POST "repos/$GH_REPO/git/refs" -f "ref=refs/heads/demo/$run_id" -f "sha=$DEMO_RESET_SHA" >/dev/null \
  || die "could not create demo/$run_id"

# --- 5. archive local state --------------------------------------------------------------
if [[ -f "$DB_PATH" ]]; then
  archive_dir="$(dirname "$DB_PATH")/archive"
  mkdir -p "$archive_dir"
  mv "$DB_PATH" "$archive_dir/loopback-$(date -u +%Y%m%dT%H%M%SZ).db"
  for ext in -wal -shm; do [[ -f "$DB_PATH$ext" ]] && mv "$DB_PATH$ext" "$archive_dir/"; done
fi

cat <<EOF
Demo run prepared. Set these for the gate and restart it:
  DEMO_RUN_ID=$run_id
  BASE_BRANCH=demo/$run_id
  DEMO_RESET_SHA=$DEMO_RESET_SHA
EOF
