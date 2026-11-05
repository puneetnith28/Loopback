import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseDetail, listAudit, listRuns, summary } from "../../apps/console-api/src/store.js";
import { openDatabase } from "../../apps/switch-gate/src/persistence/db.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";
import {
  A,
  B,
  BASE,
  FIXER,
  G,
  IROOM,
  MAINT,
  MROOM,
  OUT,
  VERIFIER,
  createHarness,
} from "../helpers/harness.js";

const PUBLIC_REPORTER = "@switch-mattermost-x-contributor:localhost";

describe("Phase 2 — Live Workflow & Agent Orchestration (20-Step Lifecycle)", () => {
  it("executes the complete 20-step workflow from public intake to gated merge and console sync", async () => {
    const h = createHarness({ mergeEnabled: true });

    // -------------------------------------------------------------------------
    // Step 1: Contributor submits bug report in public intake room
    // Step 2: Loopback receives report through Switch
    // Step 3: Admission policy validates sender, room and message
    // -------------------------------------------------------------------------
    const bugText = "slugify.extend({'%': null}) throws a TypeError when given unicode input";
    await h.say(PUBLIC_REPORTER, `${G} report ${bugText}`, { roomId: IROOM });

    // Step 5: Persistent case created in Reported state
    expect(h.state("LB-001")).toBe("Reported");
    const caseReported = getCase(h.db, "LB-001");
    expect(caseReported).not.toBeNull();
    expect(caseReported?.reportText).toBe(bugText);
    expect(caseReported?.branch).toBe("loopback/LB-001");

    // Verify console summary reflects Reported case
    let snap = summary(h.db, h.clock.now);
    expect(snap.active).toBe(1);
    expect(snap.byState.Reported).toBe(1);
    expect(snap.needsAttention).toBe(0);

    // Triage notice was sent to maintainers in MROOM
    expect(
      h.roomPosts.some(
        (p) => p.room === MROOM && p.content.includes("LB-001") && p.content.includes("slugify.extend"),
      ),
    ).toBe(true);

    // -------------------------------------------------------------------------
    // Step 4: Maintainer reviews and accepts the report
    // -------------------------------------------------------------------------
    await h.say(MAINT, `${G} accept LB-001`);
    expect(h.state("LB-001")).toBe("FixInProgress");

    // -------------------------------------------------------------------------
    // Step 6: Fixer agent receives structured task in coordination room
    // -------------------------------------------------------------------------
    const fixerTaskPost = h.roomPosts.find(
      (p) => p.room === MROOM && p.content.includes("@loopback-fixer fix LB-001"),
    );
    expect(fixerTaskPost).toBeDefined();
    expect(fixerTaskPost?.content).toContain("~~~untrusted-report");
    expect(fixerTaskPost?.content).toContain("Work only on branch loopback/LB-001");

    // Console reflects FixInProgress state
    let detail = caseDetail(h.db, "LB-001");
    expect(detail?.state).toBe("FixInProgress");

    // -------------------------------------------------------------------------
    // Step 7: Fixer investigates repository
    // Step 8: Fixer implements proposed correction
    // Step 9: Fixer opens pull request #42 from branch loopback/LB-001
    // -------------------------------------------------------------------------
    h.gh.setPull(42, {
      number: 42,
      headRef: "loopback/LB-001",
      headSha: A,
      baseRef: "main",
      baseSha: BASE,
      state: "open",
    });

    // Fixer sends advisory report block
    await h.say(
      FIXER,
      `I investigated and fixed the bug.\n\`\`\`loopback-report\n${JSON.stringify({
        type: "fixer",
        status: "fixed",
        caseId: "LB-001",
        prUrl: "https://github.com/o/r/pull/42",
        headSha: A,
        branch: "loopback/LB-001",
        testsRun: ["npm test"],
        regressionTest: "test/slugify.test.js::handles percent sign",
        limitations: [],
      })}\n\`\`\``,
    );

    // -------------------------------------------------------------------------
    // Step 10: Poller detects PR and records exact 40-character commit SHA A
    // -------------------------------------------------------------------------
    await h.poller.tick();
    expect(h.state("LB-001")).toBe("Verifying");
    const caseVerifying = getCase(h.db, "LB-001");
    expect(caseVerifying?.prNumber).toBe(42);
    expect(caseVerifying?.headSha).toBe(A);

    // -------------------------------------------------------------------------
    // Step 11: CI executes against that commit
    // -------------------------------------------------------------------------
    h.gh.pass(A);

    // -------------------------------------------------------------------------
    // Step 12: Verifier agent triggered with capability token
    // -------------------------------------------------------------------------
    const runId = h.lastRunId();
    const capability = h.lastCapability();
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(capability).toMatch(/^lbcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // -------------------------------------------------------------------------
    // Step 13: Verifier checks regression reproduces on base and passes on fix
    // Step 14: Verifier acquires cryptographic signature from signer
    // Step 15: Verifier posts signed report to internal coordination room
    // -------------------------------------------------------------------------
    await h.verifierReply("pass", {
      regressionTestFailsBeforeFix: true,
      findings: [],
      summary: "Regression confirmed failing on base, fix verified green in sandbox",
    });

    // -------------------------------------------------------------------------
    // Step 16: Loopback verifies signature, SHA binding, and policy
    // Step 17: Maintainer reviews verification evidence, case reaches AwaitingApproval
    // -------------------------------------------------------------------------
    await h.poller.tick(); // Checks CI completion
    expect(h.state("LB-001")).toBe("AwaitingApproval");

    // Maintainer is prompted with exact full commit SHA
    expect(
      h.roomPosts.some(
        (p) => p.room === MROOM && p.content.includes(`approve LB-001 ${A}`),
      ),
    ).toBe(true);

    // Console reflects AwaitingApproval
    detail = caseDetail(h.db, "LB-001");
    expect(detail?.state).toBe("AwaitingApproval");
    expect(detail?.headSha).toBe(A);

    // -------------------------------------------------------------------------
    // Step 18: Maintainer approves merge with exact commit SHA
    // -------------------------------------------------------------------------
    await h.say(MAINT, `${G} approve LB-001 ${A}`);
    expect(h.state("LB-001")).toBe("ReadyToMerge");

    detail = caseDetail(h.db, "LB-001");
    expect(detail?.state).toBe("ReadyToMerge");

    // -------------------------------------------------------------------------
    // Step 19: Maintainer triggers merge; gate evaluates safety checks and executes
    // -------------------------------------------------------------------------
    await h.say(MAINT, `${G} merge LB-001`);

    // -------------------------------------------------------------------------
    // Step 20: Loopback verifies all safety checks, confirms merge, closes case,
    // and updates console
    // -------------------------------------------------------------------------
    expect(h.state("LB-001")).toBe("Merged");
    expect(h.merger).toHaveBeenCalledTimes(1);
    expect(h.merger).toHaveBeenCalledWith(42, A);
    expect(h.gh.statuses).toContainEqual(
      expect.objectContaining({ sha: A, state: "success" }),
    );

    // Verify console API store reflects the final Merged state
    snap = summary(h.db, h.clock.now);
    expect(snap.active).toBe(0);
    expect(snap.byState.Merged).toBe(1);

    detail = caseDetail(h.db, "LB-001");
    expect(detail?.state).toBe("Merged");
    expect(detail?.headSha).toBe(A);
    expect(detail?.latestVerification?.status).toBe("pass");
    expect(detail?.approvals.length).toBe(1);
    expect(detail?.approvals[0]?.decision).toBe("approve");

    // Audit trail completeness check
    const auditEvents = listAudit(h.db, { limit: 100 }).items;
    const eventTypes = auditEvents.map((e) => e.type);

    expect(eventTypes).toContain("case.created");
    expect(eventTypes).toContain("case.triaged");
    expect(eventTypes).toContain("verification.started");
    expect(eventTypes).toContain("verification.passed");
    expect(eventTypes).toContain("approval.accepted");
    expect(eventTypes).toContain("merge.requested");
    expect(eventTypes).toContain("gate_status.posted");
    expect(eventTypes).toContain("merge.confirmed");
  });

  it("enforces maintainer approval invariant: cannot merge without maintainer approval", async () => {
    const h = createHarness({ mergeEnabled: true });
    await h.say(PUBLIC_REPORTER, `${G} report sample bug`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();

    expect(h.state("LB-001")).toBe("AwaitingApproval");

    // Attempt merge without approval
    await h.say(MAINT, `${G} merge LB-001`);

    // Refused because case is not ReadyToMerge
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state("LB-001")).toBe("AwaitingApproval");
    expect(h.posts.at(-1)).toContain("INVALID_STATE");
  });

  it("enforces outsider rejection invariant: unauthenticated outsiders cannot approve or merge", async () => {
    const h = createHarness({ mergeEnabled: true });
    await h.say(PUBLIC_REPORTER, `${G} report sample bug`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();

    // Outsider attempts approval
    await h.say(OUT, `${G} approve LB-001 ${A}`);
    expect(h.state("LB-001")).toBe("AwaitingApproval");

    // Fixer attempts approval
    await h.say(FIXER, `${G} approve LB-001 ${A}`);
    expect(h.state("LB-001")).toBe("AwaitingApproval");

    // Verifier attempts merge
    await h.say(VERIFIER, `${G} merge LB-001`);
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state("LB-001")).toBe("AwaitingApproval");
  });

  it("enforces head movement invalidation: pushing a new commit immediately invalidates prior verification and approval", async () => {
    const h = createHarness({ mergeEnabled: true });
    await h.say(PUBLIC_REPORTER, `${G} report sample bug`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();
    await h.say(MAINT, `${G} approve LB-001 ${A}`);
    expect(h.state("LB-001")).toBe("ReadyToMerge");

    // New commit pushed to PR branch (head moves to B)
    h.gh.setPull(42, { headSha: B });

    // When merge is attempted or poller ticks, head movement is caught
    await h.say(MAINT, `${G} merge LB-001`);

    expect(h.merger).not.toHaveBeenCalled();
    // Case reverts to Verifying or Stale to re-verify new commit B
    expect(["Verifying", "Stale"]).toContain(h.state("LB-001"));
    expect(h.posts.some((p) => p.includes(`head ${B}`))).toBe(true);
  });

  it("enforces cryptographic signature requirement: forged or unsigned reports are rejected", async () => {
    const h = createHarness();
    await h.say(PUBLIC_REPORTER, `${G} report sample bug`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.pass(A);
    await h.poller.tick();
    expect(h.state("LB-001")).toBe("Verifying");

    // Submit report with forged/tampered signature
    await h.verifierReply("pass", {
      signature: "0".repeat(128), // Invalid Ed25519 signature
    });

    // Verification must not pass
    expect(h.state("LB-001")).toBe("Verifying");
    expect(
      h.roomPosts.some((p) => p.content.includes("VERIFIER_SIGNATURE_INVALID")),
    ).toBe(true);

    const runs = listRuns(h.db, "LB-001", A);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).not.toBe("pass");
  });

  it("enforces policy boundary: PR modifying protected files (e.g. CI workflow or package.json) is blocked", async () => {
    const h = createHarness({ mergeEnabled: true });
    await h.say(PUBLIC_REPORTER, `${G} report sample bug`, { roomId: IROOM });
    await h.say(MAINT, `${G} accept LB-001`);

    // Fixer modified .github/workflows/ci.yml
    h.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
    h.gh.files.set(42, [".github/workflows/ci.yml", "src/fix.js"]);
    h.gh.pass(A);

    await h.poller.tick();
    await h.verifierReply("pass");
    await h.poller.tick();
    await h.say(MAINT, `${G} approve LB-001 ${A}`);

    // Merge evaluates evaluateMerge snapshot
    await h.say(MAINT, `${G} merge LB-001`);

    // Blocked due to PROTECTED_PATH_CHANGED
    expect(h.merger).not.toHaveBeenCalled();
    expect(h.state("LB-001")).toBe("Blocked");
    expect(h.posts.at(-1)).toContain("PROTECTED_PATH_CHANGED");
  });

  it("persists state across service restarts: recovers ReadyToMerge case from disk and successfully merges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopback-restart-"));
    const dbPath = join(dir, "gate.db");

    try {
      // Service Run 1: Drive case to ReadyToMerge using a file-backed DB
      const db1 = openDatabase(dbPath);
      const h1 = createHarness({ db: db1, mergeEnabled: true });

      await h1.say(PUBLIC_REPORTER, `${G} report persistent bug`, { roomId: IROOM });
      await h1.say(MAINT, `${G} accept LB-001`);
      h1.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
      h1.gh.pass(A);
      await h1.poller.tick();
      await h1.verifierReply("pass");
      await h1.poller.tick();
      await h1.say(MAINT, `${G} approve LB-001 ${A}`);
      expect(h1.state("LB-001")).toBe("ReadyToMerge");

      // Stop service instance 1 (simulate shutdown/restart)
      db1.close();

      // Service Run 2: Restart with a fresh Gate instance pointing at the same DB file
      const db2 = openDatabase(dbPath);
      // Re-use FakeGitHub state from run 1
      const h2 = createHarness({ db: db2, gh: h1.gh, mergeEnabled: true });

      // Verify case state persisted exactly
      expect(h2.state("LB-001")).toBe("ReadyToMerge");
      const c = getCase(db2, "LB-001");
      expect(c?.headSha).toBe(A);
      expect(c?.prNumber).toBe(42);

      // Maintainer executes merge in restarted service with unique eventId
      await h2.say(MAINT, `${G} merge LB-001`, { eventId: "h2-merge-01" });

      expect(h2.state("LB-001")).toBe("Merged");
      expect(h2.merger).toHaveBeenCalledTimes(1);

      // Verify console detail on restarted database shows Merged
      const detail = caseDetail(db2, "LB-001");
      expect(detail?.state).toBe("Merged");
      expect(detail?.headSha).toBe(A);

      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles interrupted in-flight merge at startup without duplicate merges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopback-crash-"));
    const dbPath = join(dir, "gate.db");

    try {
      const db1 = openDatabase(dbPath);
      const h1 = createHarness({ db: db1, mergeEnabled: true });

      await h1.say(PUBLIC_REPORTER, `${G} report crash bug causes unhandled rejection`, { roomId: IROOM });
      await h1.say(MAINT, `${G} accept LB-001`);
      h1.gh.setPull(42, { headRef: "loopback/LB-001", headSha: A });
      h1.gh.pass(A);
      await h1.poller.tick();
      await h1.verifierReply("pass");
      await h1.poller.tick();
      await h1.say(MAINT, `${G} approve LB-001 ${A}`);

      // Simulate a crash right after GitHub merge began:
      // Case is in Merging state in database when process terminates
      db1.prepare("UPDATE cases SET state = 'Merging' WHERE id = 'LB-001'").run();
      db1.close();

      // Restart service: reconcileStartup should identify Merging state,
      // move to MergeUnknown, and verify against GitHub.
      const db2 = openDatabase(dbPath);
      // GitHub confirms PR was indeed merged
      h1.gh.setPull(42, { merged: true, state: "closed", mergeCommitSha: "d".repeat(40) });
      const h2 = createHarness({ db: db2, gh: h1.gh, mergeEnabled: true });

      await h2.exec.reconcileStartup();

      // Successfully transitioned to Merged without duplicate call
      expect(h2.state("LB-001")).toBe("Merged");
      expect(h2.merger).not.toHaveBeenCalled(); // Merger not called again

      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
