# Owner actions before the live end-to-end run

Everything here needs the owner's credentials, accounts or explicit decision; Loopback's code
and agents never do it. Run `node scripts/live-readiness.mjs` before and after: it is read-only
and lists exactly what is still missing. Safety flags (`MERGE_ENABLED`,
`LOOPBACK_PRIVILEGED_ENABLED`, `VERIFIER_ISOLATION_PROVEN`) stay `false` throughout; turning any
of them on is a separate, later decision.

| # | Action | Tool / reference | Done when |
|---|---|---|---|
| 1 | Protect the `demo-reset` tag (ruleset change) | `GH_REPO=puneetnith28/loopback-demo-target deploy/github/protect-demo-reset-tag.sh` (dry run), then `--apply` | readiness: "demo-reset tag ruleset present"; `scripts/verify-github-setup.sh` with `TAG_RULESET_ID` passes |
| 2 | Issue the fixer and verifier fine-grained tokens (demo repository only, short expiry; verifier read-only) | `docs/setup.md` "Agent tokens"; put `GH_TOKEN` and `GH_REPO` in `~/.config/loopback-agents/{fixer,verifier}.env` (mode 600) | `scripts/probe-agent-token.sh fixer` and `verifier` pass; then, once authorised, `--write-probes` shows 403s |
| 3 | Gate signing configuration | `.env`: `LOOPBACK_RUN_ISSUER_KEY_PATH=<absolute path>/secrets/run-issuer.pem` (key already created, mode 600) and `VERIFIER_PUBLIC_KEY=<signer public key>` from `docs/evidence/phase-06-signer.md` | readiness: "Signing" all set and "VERIFIER_PUBLIC_KEY is the signer's public key" |
| 4 | Switch: gate agent, maintainer room, public intake room, fixer and verifier agents, the two-rule addressing policy | `docs/setup.md` §2 (Switch); fill `SWITCH_*`, `LOOPBACK_MAINTAINERS`, `LOOPBACK_FIXER_ID`, `LOOPBACK_VERIFIER_ID`, `LOOPBACK_FIXER_AGENT_ID`, `LOOPBACK_VERIFIER_AGENT_ID` | readiness: Switch and Identities all set; `npm run gate` starts (it exits 4 on an unexpected policy) |
| 5 | Run the agent sessions inside the containers | `deploy/isolation/agents.sh up`, `recycle-verifier` before each run; attach each session with `docker exec`; the verifier session must not load tooling configuration from a checkout (`prompts/verifier.md`) | `deploy/isolation/agents.sh verify` passes for all roles, including the verifier's GitHub read |
| 6 | Live run | `docs/demo-runbook.md`, `scripts/reset-demo.sh` | a real report → fixer PR → signed verifier report recorded `signature: "valid"` → `AwaitingApproval` |
| 7 | Decide D1 (repository move) | `plan.md` decision register | recorded decision |

Only after steps 1–6 hold, with evidence recorded, may the owner consider
`VERIFIER_ISOLATION_PROVEN=true` (and, separately, the other flags).
