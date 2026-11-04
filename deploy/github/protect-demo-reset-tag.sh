#!/usr/bin/env bash
# OWNER STEP (plan 6.1): create the tag ruleset that freezes refs/tags/demo-reset (no update, no
# deletion, empty bypass list). This CHANGES repository rulesets, so it is never run by an agent
# or by Loopback itself. Default is a dry run that prints the request; pass --apply to create it.
#
#   GH_REPO=puneetnith28/loopback-demo-target deploy/github/protect-demo-reset-tag.sh [--apply]
#
# Afterwards record the printed id as TAG_RULESET_ID and run scripts/verify-github-setup.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BODY="$HERE/demo-reset-tag-ruleset.json"
: "${GH_REPO:?set GH_REPO=owner/repo}"
[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GH_REPO must be owner/repo" >&2; exit 2; }
command -v gh >/dev/null && command -v jq >/dev/null || { echo "gh and jq are required" >&2; exit 2; }
jq -e '.target == "tag" and .enforcement == "active" and (.bypass_actors | length == 0)
       and (.conditions.ref_name.include == ["refs/tags/demo-reset"])' "$BODY" >/dev/null || { echo "unexpected ruleset body" >&2; exit 1; }

existing="$(gh api "repos/$GH_REPO/rulesets" --jq '.[] | select(.target == "tag") | "\(.id) \(.name)"')" || { echo "cannot list rulesets (admin access needed)" >&2; exit 1; }
if [ -n "$existing" ]; then echo "tag ruleset(s) already present, nothing created:"; echo "$existing"; exit 0; fi

if [ "${1:-}" != "--apply" ]; then
  echo "DRY RUN: would POST repos/$GH_REPO/rulesets with:"; jq . "$BODY"
  echo "Re-run with --apply to create it."
  exit 0
fi
read -r -p "Create the tag ruleset on $GH_REPO? Type the repository name: " answer
[[ "$answer" == "$GH_REPO" ]] || { echo "confirmation did not match; nothing changed" >&2; exit 1; }
id="$(gh api -X POST "repos/$GH_REPO/rulesets" --input "$BODY" --jq .id)"
echo "created tag ruleset $id; set TAG_RULESET_ID=$id"
