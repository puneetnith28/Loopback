# Release readiness

Status of the release checks (plan steps 10.6 and 10.8) on the current `main`. Evidence classes:
**Local** = enforced by code and covered by passing automated tests with fakes; **Live** = needs
the real GitHub and Switch setup, not yet exercised; **Met** = satisfied as stated.
Nothing here counts a simulated test as live evidence.

## Release hygiene (step 10.6) — run 2026-11-04, before the code freeze

| Check | Result |
|---|---|
| Licence | Apache-2.0 (`LICENSE`, every `package.json`). Production dependencies: MIT (15), Apache-2.0 (2), ISC (1), all compatible. The demo target is the maintainer's own repository, so no third-party code is redistributed. |
| `SECURITY.md` | Private reporting via GitHub security advisories, supported versions, security model summary, known limits including advisory verification and token attribution. |
| `.env.example` | Placeholders and non-secret defaults only; every secret setting is empty. |
| Local-only files | `plan.md`, `implementation.md`, `ANTIGRAVITY_HANDOFF.md`, `.env` and `secrets/` are git-ignored and untracked. |
| Secret scan | gitleaks runs in CI on every push (`.github/workflows/ci.yml`). |
| Dependency audit | `npm audit --omit=dev`: 0 vulnerabilities. Development-only: one moderate advisory (GHSA-g3hv-75wg-m249, `minimatch` via ESLint), accepted and recorded in `docs/threat-model.md`. |

Re-run all of these on the frozen release candidate (step 10.7).

## Definition of done (step 10.8, `implementation.md` §19)

| # | Item | Class | Evidence or what is missing |
|---|---|---|---|
| 1 | A human and an AI agent complete a real task through Switch | **Live** | Needs the fixer/verifier agents and the intake room (setup steps 7.2, 3.10). Locally: `tests/integration/e2e-simulated.test.ts` (fakes). |
| 2 | The fixer opens a genuine GitHub PR | **Live** | Needs the demo target, tokens and a live fixer (6.1, 6.3, 7.10). |
| 3 | A regression test demonstrates the bug and the fix | **Live** | Demo target with the seeded bug (1.5, 6.1). The verifier's report records `regressionTestFailsBeforeFix`. |
| 4 | Verification evidence identifies the exact current commit | **Local** | Run id, repository, PR and full SHA bound; live head re-read; superseded runs; optional Ed25519 signatures (`workflow.test.ts`, `verifier-signature.test.ts`, `signature.test.ts`). Advisory until isolation is proven. |
| 5 | Authenticated maintainer approval is bound to that commit | **Local** (identity **Live**) | Full 40-character SHA, exact equality, exact sender ids (`merge-gate.test.ts`, `admission.test.ts`). Live sender attribution for agents not yet observed. |
| 6 | Changing the commit invalidates the old approval and verification | **Local** | `merge-gate.test.ts` (commit binding), `interleaving.test.ts` (100 runs), `reconcile.test.ts`. |
| 7 | The gatekeeper rechecks live GitHub state before merging | **Local** | Snapshot with head before/after, ruleset and check-source validation, head re-read after the status (`policy.test.ts`, `merge-gate.test.ts`). |
| 8 | Only the gatekeeper can perform the merge (ruleset proves it) | **Live** | Ruleset sources are pinned (`test` → 15368, `loopback/gate` → 5598944) and validated at runtime; the nine-outcome ruleset proof (6.6) is not run. |
| 9 | A successful merge is confirmed by GitHub and recorded | **Local** | `merge-gate.test.ts`, `e2e-simulated.test.ts` (fakes); no live merge yet (8.10). |
| 10 | Unauthorized and stale approvals are visibly refused | **Local** | `intake.test.ts`, `router.test.ts`, `merge-gate.test.ts`, `composition.test.ts`. |
| 11 | Duplicate events and uncertain API responses are handled safely | **Local** | Processed events, `MergeUnknown` reconciliation, no blind retries (`merge-gate.test.ts`, `reconcile.test.ts`, `poller-backoff.test.ts`). |
| 12 | Tests cover state machine, policy, integration and security | **Met** | 733 tests across unit, integration and security suites; coverage thresholds enforced in CI. Live suites exist but are opt-in. |
| 13 | Setup works from a clean clone | **Local** | A fresh clone passes `npm ci`, typecheck, lint and `test:coverage` (2026-11-04). A clone reaching `/readyz` OK against live services (10.3) is **Live**. |
| 14 | The README explains Switch's role | **Met** | `README.md` §2. |
| 15 | The demo shows a successful run and a meaningful refusal | **Live** | `docs/demo-runbook.md` is ready; recording needs live runs (10.2, 10.9). |
| 16 | No secrets are committed; licence and security-reporting instructions exist | **Met** | gitleaks in CI, the hygiene table above, `LICENSE`, `SECURITY.md`. |

**Summary:** 3 met, 7 locally enforced and tested, 6 need the live setup. Every unmet item is
listed in the README's known limits.
