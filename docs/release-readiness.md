# Release readiness

Status of the release checks (plan steps 10.6 and 10.8), updated 2026-11-05. Evidence classes:

- **Live:** observed on real GitHub and Switch.
- **Local:** enforced by code and covered by passing automated tests with fakes, not yet seen live.
- **Met:** satisfied as stated.
- **Not done:** still to do.

Nothing here counts a simulated test as live evidence.

## Code freeze and final review (step 10.7)

Not frozen yet: the final commit comes after the remaining live runs. The earlier freeze at `2326cc4`
(2026-11-04) no longer describes `main`.

A security review of `d777967..045cd87` (gate, console API, console, scripts, isolation) found one high
and four low issues, all since fixed with tests. The high one was a verifier permission template that
pre-approved raw `git diff`, whose `--output` option can write a Git hook; it was never installed. By
reading the code, the review found no way to reach `Merged` without valid evidence. It did not cover
unchanged code such as the signer server, the router and the sandbox runner.

## Release hygiene (step 10.6)

| Check | Result |
|---|---|
| Tests | Windows 1398 passed, 0 failed, with typecheck and lint clean. Linux 1465 passed, 0 failed, one commit earlier. To repeat on the final commit. |
| Secret scan | gitleaks 8.24.3 over the full history: 90 commits, no leaks. Run locally; CI also runs it, and CI results for the latest commits have not been checked. |
| Dependency audit | `npm audit --omit=dev`: 0 vulnerabilities. |
| Licence | Apache-2.0 (`LICENSE`). The dependency licence count was last taken at `2326cc4`, before the frontend's dependencies arrived, so it needs repeating at the freeze. |
| `SECURITY.md` | Private reporting via GitHub security advisories, and known limits. |
| `.env.example` | Placeholders and non-secret defaults only. |
| Local-only files | `plan.md`, `implementation.md`, `.env` and `secrets/` are git-ignored and untracked. |

## Definition of done (step 10.8, `implementation.md` §19)

| # | Item | Class | Evidence or what is missing |
|---|---|---|---|
| 1 | A human and an AI agent complete a real task through Switch | **Live**, once | `LB-001` ([evidence](evidence/phase-08-day2.md)). It took four attempts, and a person guided the verifier. |
| 2 | The fixer opens a genuine GitHub PR | **Live** | Demo target PR #3, from a real fixer session. |
| 3 | A regression test demonstrates the bug and the fix | **Live** | The sandbox's own results: 9 of 9 pass on `23e39be`, and the null test fails on `70a5362`. |
| 4 | Verification evidence identifies the exact current commit | **Live** | Run `9d0d549d`, signature `valid`, live head re-read. Advisory, because the agents run on the host. |
| 5 | Authenticated maintainer approval is bound to that commit | **Live** | Full SHA approved; a wrong SHA refused with `APPROVAL_SHA_MISMATCH`. |
| 6 | Changing the commit invalidates the old approval and verification | **Local** | `merge-gate.test.ts`, `interleaving.test.ts`, `reconcile.test.ts`. The live extra-push run is still to do. |
| 7 | The gatekeeper rechecks live GitHub state before merging | **Live** | `merge.requested`, then `gate_status.posted`, then the merge with its SHA precondition. |
| 8 | Only the gatekeeper can perform the merge (ruleset proves it) | **Live** | [Ruleset proof](evidence/phase-06-ruleset-proof.md): every outcome passed, including a refused merge from the maintainer's account with green CI. |
| 9 | A successful merge is confirmed by GitHub and recorded | **Live** | `02445c3`, merged by the gate's App, confirmed by reading GitHub. |
| 10 | Unauthorized and stale approvals are visibly refused | **Live** for unauthorized and wrong-SHA; **Local** for stale | `phase-05.md`, `phase-08-day2.md`; the stale case is item 6. |
| 11 | Duplicate events and uncertain API responses are handled safely | **Local** | `merge-gate.test.ts`, `reconcile.test.ts`, `poller-backoff.test.ts`. The confirmation step ran live, but no real uncertain outcome has occurred. |
| 12 | Tests cover state machine, policy, integration and security | **Met** | See the hygiene table. Live suites exist but are opt-in. |
| 13 | Setup works from a clean clone | **Local** | A clone from GitHub passes `npm ci`, the build and the tests, and the console starts. That was run by the author on the same machine, and no one else has done the live setup from the README. |
| 14 | The README explains Switch's role | **Met** | `README.md` §2. |
| 15 | The demo shows a successful run and a meaningful refusal | **Not done** | `docs/demo-runbook.md` is ready; the recording comes with the final live run. |
| 16 | No secrets are committed; licence and security-reporting instructions exist | **Met** | The hygiene table above. |

**Summary:** 12 met or live (one of them only partly), 3 local, 1 not done. Every gap is listed in the
README's known limits.

## Known gaps besides the table

- **Verifier reliability:** it has not yet completed a run without a person guiding it. The new
  instructions and retry are tested but not yet used live.
- **Lost `verify`:** one command posted on 2026-11-04 never reached the gate, cause unknown. Logging now
  exists to diagnose a repeat.
- **Console:** verified on real data through the dev server ([evidence](evidence/phase-11-console.md)).
  The API doesn't serve the production console itself yet.
- **Live gate build:** the hardening since the first merge has not run in a live gate yet.
