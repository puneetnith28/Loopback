# Phase 8: first real merge through the gate (`LB-001`)

Recorded 2026-11-05. Every value below comes from the gate's audit table, GitHub's public API or the
sandbox runner's own result files. No secret appears here.

## Result

| Item | Value |
|---|---|
| Repository | `puneetnith28/loopback-demo-target` |
| Pull request | #3, branch `loopback/LB-001`, opened by the fixer agent |
| Commit approved and merged | `23e39bede369c65691a124e68bb1d1aa59e8dd0a` |
| Merge commit on `main` | `02445c3ad4151e8847fa880b42cbbe07e50e00eb` (squash, attempt 1 of 2) |
| Merged by (GitHub) | `loopback-gate-puneetnith28[bot]` |
| Verification run | `9d0d549d-a125-4a4d-b843-622c9205e216`: `pass`, signature `valid`, `advisory` |
| Case state | `Merged` |

## Real refusals, on the same case

| When (UTC) | Command | Gate's answer |
|---|---|---|
| 08:24:38 | `approve LB-001 0000…0000` | `REFUSED (APPROVAL_SHA_MISMATCH)`: you approved 000000000000 but the PR is at 23e39bede369 |
| 08:25:01 | `merge LB-001` with `MERGE_ENABLED=false` | `BLOCKED (MERGE_DISABLED)` |
| 08:05:49 | Verifier report with malformed findings, unsigned, with results from an older commit | `REFUSED (AGENT_OUTPUT_INVALID)` |

An earlier refusal is in [phase-05.md](phase-05.md) (Day-1 gate).

## Timeline of the passing attempt (UTC)

| Time | Event | Actor |
|---|---|---|
| 08:03:11 | `case.retasked` VerificationFailed → FixInProgress | maintainer |
| 08:05:41 | `pr.created`, new head `23e39be` | poller |
| 08:05:42 | `verification.started`, signing capability issued for this run | gate |
| 08:05:52 | `fixer.reported` | fixer |
| 08:06:03 | `ci.observed`: `test` success (run 127125730836) | gate |
| 08:20:26 | Sandbox: `23e39be` tests, exit 0, 9 of 9 pass | runner |
| 08:20:34 | Sandbox: `70a5362` tests, exit 1, null regression test fails with the original `TypeError` | runner |
| 08:22:10 | `sign.issued` for this run | signer |
| 08:22:19 | `verification.passed`, signature `valid`; AwaitingApproval | verifier, gate |
| 08:24:49 | `approval.accepted` for the full SHA; ReadyToMerge | maintainer |
| 08:28:47 | `merge.requested`; Revalidating | maintainer |
| 08:28:50 | `gate_status.posted`, `loopback/gate` success on that SHA | gate |
| 08:28:52 | Merging, attempt 1 | gate |
| 08:28:55 | MergeUnknown (`MERGE_OUTCOME_UNKNOWN`, stage `confirming`) | gate |
| 08:28:56 | `merge.confirmed` by reconciliation; Merged | gate |

The merge outcome could not be confirmed straight after the merge call, so the case entered
`MergeUnknown` for about a second and the reconciler confirmed the merge commit on GitHub. That is
the designed path (D15), and no second merge call was made. The cause of the failed first
confirmation was not investigated.

## Independent checks

- `git diff 70a5362 23e39be` touches only `src/index.js` (the fix) and `test/index.test.js` (three new
  regression tests). No CI, package or configuration file changed.
- The operator separately ran the previous head (`48bc10d`) and the base (`70a5362`) through the
  sandbox: 8 of 8 pass with the fix, and the null test fails without it. Throwaway copies of an earlier
  head (`8740ea9`) with the original `src/index.js` restored showed the null and undefined tests both fail.
- The merged commit's `loopback/gate` status is `success`.
- GitHub's rules on `main`: pull request required, squash only, `test` and `loopback/gate` required
  from pinned integrations, deletion and non-fast-forward blocked.

The verifier's report says "4 new regression tests". The correct count is 3 new plus the seeded one.
This is an info-level wording error in the report.

## What this does not prove

Read these before relying on this evidence.

1. **Verification is advisory.** Console runs the agents on the host as the desktop user, outside
   the isolation containers, so `VERIFIER_ISOLATION_PROVEN` stays `false`. A human review was required.
2. **The verifier did not follow its prompt unaided.** A human pasted numbered commands and answered
   each permission prompt. The free model (`openrouter/cohere/north-mini-code:free`) wandered without them.
3. **Merged on `main`, not a per-run branch.** D12 asks for `demo/<run-id>` bases. This run used the demo
   repository's `main` to meet the submission time, so base-integrity on a run branch is not shown here.
4. **Four attempts were needed.** Three runs timed out (`31a4a634`, `42ff21e2`, `bab56602`). Causes
   found: the OpenCode free-tier limit; a permission prompt left unanswered; the runner's tmpfs losing
   its owner after a machine restart (now fixed); report instructions that omitted the findings format.
   Each retry needed a new commit, by design at the time, which is why the PR carries three extra
   tests. D33 has since added `verify` as a retry after a timeout.
5. **An unsigned report could have passed on this run.** The gate then accepted unsigned reports in
   advisory mode. The stale report above was refused only for its format. The passing report was
   checked by hand: signature `valid`, and its results matched the runner's result files. D32 has
   since made the gate reject unsigned reports whenever a key is configured.
6. **`verify` delivery is unexplained.** A `verify LB-001` posted at 20:42 UTC on 2026-11-04 never
   reached the gate's records, while other commands did. The router marks every delivered event as
   processed, so it was not delivered to the gate. Switch's log for that time shows no cause. A
   `switch.inbound` log line has been added so that a repeat can be diagnosed.
7. **Not done:** extra push → Stale on a live PR, the nine ruleset outcomes, two clean end-to-end runs,
   the fresh-clone test, and a security review of this phase.
