/**
 * Read API v1 response builders for TESTS ONLY (Vitest and Playwright). Never imported by src/ (enforced by
 * eslint.config.boundaries.js), so none of this can reach a build. Every builder produces data that passes the
 * console's own schemas; tests that need invalid data change one field explicitly.
 */
export const SHA_A = "e804775a5938f9afe55fa5321875735734e3e1a5";
export const SHA_B = "70a5362de6f0ae97b11b83c4406d6316433daa8d";
export const SHA_C = "b41c9e0712d4c1a5e9f0a3b6c7d8e9f001122334";
export const SHA_BASE = "1111111111111111111111111111111111111111";
export const GENERATED_AT = "2026-11-04T10:00:00Z";

type Json = Record<string, unknown>;

export function envelope(data: unknown, meta: Partial<{ generatedAt: string; nextCursor: string | null; unavailable: string[] }> = {}): Json {
  return { success: true, data, meta: { generatedAt: GENERATED_AT, nextCursor: null, unavailable: [], ...meta } };
}

export function errorEnvelope(code: string, message = "error"): Json {
  return { success: false, error: { code, message } };
}

export function caseSummary(over: Json = {}): Json {
  return {
    id: "LB-042", state: "AwaitingApproval", repo: "acme/widgets", prNumber: 2, headSha: SHA_A, blockedReason: null,
    reportExcerpt: "formatToken throws TypeError when the replace mapping contains null",
    stateEnteredAt: "2026-11-04T09:40:00Z", createdAt: "2026-11-04T08:00:00Z", updatedAt: "2026-11-04T09:40:00Z",
    ...over,
  };
}

export function verificationRun(over: Json = {}): Json {
  return {
    id: "run-1", headSha: SHA_A, status: "pass", requestedAt: "2026-11-04T09:20:00Z", completedAt: "2026-11-04T09:30:00Z",
    mode: "isolated", signature: "valid", summary: "Regression test fails before the fix and passes after it.",
    findings: [], regressionTestFailsBeforeFix: true, provenance: "signed-verifier", ...over,
  };
}

export function auditEvent(over: Json = {}): Json {
  return {
    id: 1, caseId: "LB-042", actorId: "system", eventType: "case.state_changed", targetSha: null, reasonCode: null,
    payload: { from: "Verifying", to: "AwaitingApproval" }, createdAt: "2026-11-04T09:40:00Z", provenance: "gate", ...over,
  };
}

export function caseDetail(over: Json = {}): Json {
  return {
    ...caseSummary(),
    branch: "loopback/LB-042",
    reportText: "formatToken throws TypeError when the replace mapping contains null.\nSteps: call formatToken('a', { a: null }).",
    commits: [{ headSha: SHA_A, baseSha: SHA_BASE, observedAt: "2026-11-04T09:00:00Z", provenance: "github" }],
    ciChecks: [{
      id: "ci-1", headSha: SHA_A, checkName: "test", appSlug: "github-actions", status: "completed", conclusion: "success",
      htmlUrl: "https://github.com/acme/widgets/actions/runs/1", observedAt: "2026-11-04T09:10:00Z", provenance: "github",
    }],
    verificationRuns: [verificationRun()],
    approvals: [],
    mergeOperations: [],
    evidence: { verifiedSha: SHA_A, runId: "run-1" },
    lastGateDecision: { outcome: "blocked", reasonCodes: ["APPROVAL_MISSING"], headSha: SHA_A, observedAt: "2026-11-04T09:41:00Z", provenance: "gate" },
    fixerClaim: {
      outcome: "fixed", headSha: SHA_A, testsRun: ["npm test"], regressionTest: "tests/format.test.ts",
      limitations: ["Only the null case was covered."], summary: "Guarded null mapping values.", reportedAt: "2026-11-04T09:05:00Z", provenance: "agent-claim",
    },
    prSnapshot: null,
    ...over,
  };
}

/** The same case after the fixer pushed again: head moved from SHA_A to SHA_C, evidence still bound to SHA_A. */
export function caseDetailHeadMoved(): Json {
  return caseDetail({
    id: "LB-043", state: "Stale", headSha: SHA_C,
    commits: [
      { headSha: SHA_A, baseSha: SHA_BASE, observedAt: "2026-11-04T09:00:00Z", provenance: "github" },
      { headSha: SHA_C, baseSha: SHA_BASE, observedAt: "2026-11-04T09:50:00Z", provenance: "github" },
    ],
    lastGateDecision: { outcome: "blocked", reasonCodes: ["HEAD_MOVED", "VERIFICATION_STALE"], headSha: SHA_C, observedAt: "2026-11-04T09:51:00Z", provenance: "gate" },
  });
}

export function overview(over: Json = {}): Json {
  return {
    countsByState: {
      Reported: 1, Triaged: 0, FixInProgress: 1, PRCreated: 0, Verifying: 0, VerificationFailed: 0, AwaitingApproval: 1,
      ReadyToMerge: 0, Revalidating: 0, Merging: 0, Merged: 3, Stale: 1, Blocked: 0, MergeUnknown: 0,
    },
    attention: [caseSummary(), caseSummary({ id: "LB-043", state: "Stale", headSha: SHA_C, reportExcerpt: "Date parsing off by one day" })],
    verification: { windowDays: 7, pass: 4, fail: 1, invalid: 0, timeout: 0, requested: 1, superseded: 1 },
    recentActivity: [
      auditEvent(),
      auditEvent({ id: 2, eventType: "verification.passed", actorId: "verifier", provenance: "signed-verifier", targetSha: SHA_A, payload: { signature: "valid", advisory: false } }),
    ],
    ...over,
  };
}

export function configSummary(over: Json = {}): Json {
  return {
    repo: "acme/widgets", baseBranch: "main", requiredChecks: ["test"], verificationMode: "isolated",
    safety: { mergeEnabled: false, privilegedEnabled: false, verifierIsolationProven: false },
    quorum: 1, gateMention: "@loopback-gate", schemaVersion: 3, pollIntervalMs: 15000, verifyTimeoutMs: 600000, fixTimeoutMs: 1800000,
    ...over,
  };
}

export function systemStatus(over: Json = {}): Json {
  return { ok: true, failing: [], checkedAt: "2026-11-04T09:59:00Z", ...over };
}

export function runListItem(over: Json = {}): Json {
  return { ...verificationRun(), caseId: "LB-042", caseState: "AwaitingApproval", caseHeadSha: SHA_A, ...over };
}

/** A complete happy-path API keyed by path (no query string). */
export function happyApi(): Record<string, Json> {
  return {
    "/api/v1/overview": envelope(overview()),
    "/api/v1/cases": envelope([caseSummary(), caseSummary({ id: "LB-043", state: "Stale", headSha: SHA_C, reportExcerpt: "Date parsing off by one day" })]),
    "/api/v1/cases/LB-042": envelope(caseDetail()),
    "/api/v1/cases/LB-043": envelope(caseDetailHeadMoved()),
    "/api/v1/cases/LB-042/audit": envelope([auditEvent()]),
    "/api/v1/cases/LB-043/audit": envelope([auditEvent({ caseId: "LB-043", eventType: "commit.changed", targetSha: SHA_C, payload: { from: SHA_A, to: SHA_C } })]),
    "/api/v1/audit": envelope([auditEvent(), auditEvent({ id: 2, eventType: "fixer.reported", actorId: "fixer", provenance: "agent-claim", payload: { outcome: "fixed" } })]),
    "/api/v1/verification-runs": envelope([runListItem(), runListItem({ id: "run-0", caseId: "LB-043", caseState: "Stale", headSha: SHA_A, caseHeadSha: SHA_C })]),
    "/api/v1/config/summary": envelope(configSummary()),
    "/api/v1/status": envelope(systemStatus()),
  };
}
