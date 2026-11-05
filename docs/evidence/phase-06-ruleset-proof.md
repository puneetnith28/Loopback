# Ruleset proof (step 6.6)

Run 2026-11-05T09:37:15.010Z by `scripts/ruleset-proof.mjs` against `puneetnith28/loopback-demo-target`, run branch `demo/20261105-e97397700210bfc8` at `70a5362de6f0ae97b11b83c4406d6316433daa8d`, throwaway PR #5.
The throwaway PR started from `02445c3ad4151e8847fa880b42cbbe07e50e00eb`, because the run branch holds the seeded bug and a PR from it fails CI.
Outcomes 6, 7, 8 and the gate's half of 9 are also proved by `tests/security/demo-base-integrity.test.ts`.

| # | Outcome | Expected | Actual | Verdict |
|---|---|---|---|---|
| 5 | the run branch exists before the fixer is tasked | 200 | 200 | **PASS** |
| 9a | the run branch is at the recorded commit | 70a5362de6f0ae97b11b83c4406d6316433daa8d | 70a5362de6f0ae97b11b83c4406d6316433daa8d | **PASS** |
| setup | the fixer can create its case branch | 201 | 201 | **PASS** |
| setup | the fixer can commit and open a PR | 201 | 201 | **PASS** |
| setup | the `test` check is green on the PR head | success | success | **PASS** |
| 1 | green CI but no loopback/gate: the maintainer's account cannot merge | refused (403/405/409/422) | 405 | **PASS** |
| 2 | the fixer's token cannot merge | refused (403/405/409/422) | 405 | **PASS** |
| 3 | the fixer's token cannot post loopback/gate | refused (403/404) | 403 | **PASS** |
| 3b | a loopback/gate success from another source does not unlock a merge | refused (403/405/409/422) | 405 | **PASS** |
| 4 | the fixer's token cannot push directly to the run branch | refused (403/409/422) | 409 | **PASS** |
| 4b | the fixer's token cannot change a workflow | refused (403/404) | 403 | **PASS** |
| 6 | a competing demo branch (the gate refuses a PR on it: WRONG_BASE, see the test) | either; recorded | 201 | **PASS** |
| 9b | the demo-reset tag cannot be moved | refused (403/409/422) | 422 | **PASS** |

**Overall: every outcome passed.**
