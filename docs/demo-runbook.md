# Loopback — Demo Runbook and Recording Guide

This document is the executable checklist for the 3-minute hackathon video submission.

> **Status: not recorded yet.** One real case (`LB-001`) has gone through this flow live, without the
> Stale scene and with a person guiding the verifier: see `docs/evidence/phase-08-day2.md`. The example
> replies below are the gate's real wording, captured from a simulated run
> (`tests/integration/e2e-simulated.test.ts`), so exact details can differ live. Verification is shown
> as **advisory**: the verifier is not an isolated identity on the current setup, and the demo must not
> say otherwise. Merging requires `MERGE_ENABLED=true` and `LOOPBACK_PRIVILEGED_ENABLED=true`.

---

## 1. Prerequisites and Recording Environment

- **Resolution & Zoom**: Record at 1080p (1920×1080). Zoom Mattermost chat font to 125%.
- **Secret Hygiene**: Ensure no terminal with `.env`, private keys, PATs, or shell history containing secrets is displayed on screen. Keep provider dashboards that show API keys off camera too. The signing capability in the gate's request is visible in chat: it is bound to one run and expires with it.
- **Timing Target**: 2:45 to 3:00 total duration.
- **Speed-up Rule**: Speed up long agent thinking/running periods (2× to 4×) and **label the speed-up on screen** (e.g. `[2x Speed: Agent running tests]`). Keep raw unedited video footage.
- **Pre-flight Script Execution**:
  ```bash
  # Ensure clean demo branch and fresh database
  GH_REPO="puneetnith28/loopback-demo-target" DEMO_RESET_SHA="<sha>" RULESET_ID="<id>" ./scripts/reset-demo.sh
  npm run migrate
  npm run gate
  ```
  Stop the gate first: the reset archives the database. Then set `DEMO_RUN_ID` and `BASE_BRANCH` in `.env` to the values it prints. On Windows, run the script from Git Bash and see `docs/windows.md`.
- **Before you press record**: confirm the agents have model quota, and answer every permission prompt straight away. An unanswered prompt freezes an agent while its run counts down.
- **Rooms Setup**:
  - Public intake room: e.g. `loopback-intake`
  - Maintainer room: `loopback-maintainers` (members: Maintainer, `@loopback-gate`, `@loopback-fixer`, `@loopback-verifier`)

---

## 2. Chronological Scene-by-Scene Script (3 Minutes)

### Act 1: The Problem & Public Intake (0:00 – 0:35)

1. **0:00 – 0:15 | Scene 1: Introduction & Trust Problem**
   - **Visual**: Maintainer room showing the three agents.
   - **Narration**: *"AI coding agents can generate fixes in minutes, but how do maintainers know that what actually merges is what they approved, without trusting the agent's own word? Loopback runs inside a Switch collaboration room and enforces commit-level accountability."*
2. **0:15 – 0:35 | Scene 2: Public Bug Intake & Maintainer Triage**
   - **Visual**: Switch to `loopback-intake` room. An external contributor types:
     ```text
     @loopback-gate report formatToken throws TypeError when extend({ '%': null }) is used
     ```
   - **Expected Gate Reply in Intake**:
     ```text
     Thanks — received as LB-001. A maintainer will review it before any work starts.
     ```
   - **Visual**: Switch to `loopback-maintainers` room. Gate posts triage notice:
     ```text
     [LB-001] Public report awaiting triage (63 chars, shown in full, links defanged; untrusted, from the intake room): «formatToken throws TypeError when extend({ '%': null }) is used»
     accept LB-001 — task the fixer · decline LB-001 <reason>
     ```
   - **Action**: Maintainer types:
     ```text
     @loopback-gate accept LB-001
     ```
   - **Expected Gate Reply**:
     ```text
     [LB-001] LB-001 accepted · state Triaged → FixInProgress · tasked the fixer
     ```

---

### Act 2: Autonomous Fix, PR, and Independent Verification (0:35 – 1:15)

3. **0:35 – 0:55 | Scene 3: Fixer Agent PR Creation**
   - **Visual**: `@loopback-fixer` picks up the task, reproduces seeded issue #1 with a regression test, opens PR against `demo/<run-id>`.
   - **Narration**: *"The fixer reproduces the bug, adds a regression test, and opens a pull request. The gatekeeper verifies the PR directly against GitHub's API rather than trusting the fixer."*
   - **Cut**: Quick view of GitHub PR with commit `3f9c2ab...` and green Actions `test` run. Mention: *Agent PRs appear under the maintainer's personal GitHub account because tokens are personal fine-grained PATs.*
4. **0:55 – 1:15 | Scene 4: Verifier & Gate Readiness**
   - **Visual**: `@loopback-verifier` reviews the diff independently and posts structured evidence:
     ```text
     @loopback-gate
     ```loopback-report
     {
       "caseId": "LB-001",
       "runId": "...",
       "verdict": "pass",
       "headSha": "3f9c2ab...",
       "regressionTestFailsBeforeFix": true
     }
     ```
     ```
   - **Expected Gate Prompt**:
     ```text
     [LB-001] Ready for approval: @loopback-gate approve LB-001 <full 40-character SHA of 3f9c2ab…>
     STOPPED (VERIFICATION_ADVISORY): Verification is advisory: the verifier's isolation has not been proven yet. Review the diff yourself before approving.
     ```
   - **Narration**: *"The verifier validates that the regression test failed before the fix and passes after. Notice the advisory badge until full OS-level isolation is proven."*

---

### Act 3: Negative Paths — Stale Commit & Outsider Refusal (1:15 – 2:05)

5. **1:15 – 1:35 | Scene 5: Commit-Bound Approval**
   - **Action**: Maintainer copies the full 40-character SHA from the prompt and approves (a short SHA is refused):
     ```text
     @loopback-gate approve LB-001 <full 40-character SHA>
     ```
   - **Expected Gate Reply**:
     ```text
     [LB-001] Approval recorded for <full SHA> by <maintainer participant id> · state ReadyToMerge
     ```
6. **1:35 – 1:55 | Scene 6: The PR Moves (The Negative Demonstration)**
   - **Action**: An extra commit lands on the PR branch (e.g. pushed via fixer or test branch).
   - **Action**: Maintainer types:
     ```text
     @loopback-gate merge LB-001
     ```
   - **Expected Gate Refusal**:
     ```text
     [LB-001] BLOCKED (HEAD_MOVED): The PR now points to 7a1d94e820ab. Evidence for the previous commit does not apply.
     ```
   - **Note**: the gate also asks the verifier to review the new head. If the poller notices the new commit before the `merge` command, the case is already re-verifying and `merge` is refused as not ready instead.
   - **Narration**: *"This is Loopback's critical security guarantee. An extra commit landed after approval. Even though the PR is the same, Loopback refuses to merge: human approval was bound to the exact earlier commit."*
7. **1:55 – 2:05 | Scene 7: Unauthorized Sender Refusal (D27)**
   - **Visual**: Outsider or unprivileged user tries:
     ```text
     @loopback-gate merge LB-001
     ```
   - **Expected Gate Reply**:
     ```text
     REFUSED: That request is not available to you here.
     ```
   - **Narration**: *"Unauthorized users receive rate-limited generic refusals without disclosing privileged command internals."* (The list of usable commands is added only for an unknown command.)

---

### Act 4: Re-verification, Controlled Merge & Audit Trail (2:05 – 2:40)

8. **2:05 – 2:25 | Scene 8: Fresh Re-verification and Merge**
   - **Visual**: Gate poller detected the new commit, re-tasked verifier, and prompted for the new full SHA:
     ```text
     [LB-001] Ready for approval: @loopback-gate approve LB-001 <full 40-character SHA of 7a1d94e…>
     STOPPED (VERIFICATION_ADVISORY): Verification is advisory: …
     ```
   - **Action**: Maintainer approves new SHA and merges:
     ```text
     @loopback-gate approve LB-001 <full 40-character SHA>
     @loopback-gate merge LB-001
     ```
   - **Expected Gate Reply**:
     ```text
     [LB-001] MERGED: GitHub confirmed PR #<n> merged as 8c3b2f1…. Audit: <n> events.
     ```
   - **Narration**: *"Fresh evidence, fresh maintainer approval, and the gatekeeper executes the merge with GitHub's SHA precondition. Only the gatekeeper App has merge credentials."*
9. **2:25 – 2:40 | Scene 9: Complete Append-Only Audit Trail**
   - **Action**: Maintainer requests audit:
     ```text
     @loopback-gate audit LB-001
     ```
   - **Visual**: Gate outputs the Markdown audit table showing:
     - `case.created`, `case.triaged`, `fixer.started`, `pr.created`
     - `verification.started`, `verification.passed` (first SHA), `approval.accepted` (first SHA)
     - `merge.requested`, `commit.changed` (`HEAD_MOVED`), `verification.started` (second SHA)
     - `command.refused` (`NOT_AUTHORIZED`, the outsider's attempt)
     - `verification.passed`, `approval.accepted` (second SHA)
     - `merge.requested`, `gate_status.posted`, `merge.confirmed`

     (The table shows the newest 15 events first; `case.state_changed` rows are interleaved.)
   - **Narration**: *"Every state transition, evidence check, refusal, and merge is recorded in an immutable, append-only SQLite audit log."*

---

### Act 5: Summary & Architecture Slide (2:40 – 3:00)

10. **2:40 – 3:00 | Scene 10: Conclusion**
    - **Visual**: Display architecture diagram from `docs/architecture.md`.
    - **Narration**: *"Loopback turns open-source AI bug fixing from an uncontrolled risk into an auditable, safe workflow. GitHub remains the source of truth, human maintainers retain exclusive authority, and agents do the heavy lifting safely."*

---

## 3. Demo Failure Modes & Fast Recovery

| Glitch during recording | Immediate Recovery Action |
|---|---|
| Typing error in SHA | A wrong full SHA gives `APPROVAL_SHA_MISMATCH`; a short or malformed one is not accepted as a command. Re-copy the exact 40-character SHA from the gate's prompt. |
| GitHub rate limit | Gate reports `RATE_LIMITED` and pauses polling until GitHub's reset on its own. Wait; do not switch credentials. |
| Switch socket drops | The gate reconnects with backoff (0.5–30 s), fenced on its generation. If it was **taken over** (another client attached), it stops with exit code 3 by design: do not restart it automatically; find and stop the other client first. |
| Test run failed | Run `./scripts/reset-demo.sh` to get a fresh `demo/<run-id>` branch and re-record. |
| An agent shows "Queued" or sits idle | Look for an unanswered permission prompt in its older threads and answer it, or click **Stop current work**. Then check the OpenCode log for `Free usage limit reached`: a quota error looks like silence in chat. |
| Verification timed out | `@loopback-gate verify <case>` starts a new run on the same commit, if the head has not moved. Anything else needs `retask`, then a new commit. |
| A command gets no reply | Check the gate's log for a `switch.inbound` line. If there is none, Switch did not deliver the message: post it again. |
