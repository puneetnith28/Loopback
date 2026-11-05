import { z } from "zod";
import { CASE_STATES, CaseId, FullSha, ParticipantId, RepoSlug } from "@loopback/contracts";

/**
 * Read API v1 response models — a CONTRACT PROPOSAL owned by the console until the backend team adopts it
 * (docs/api-contract-v1.md maps every field to the gate's SQLite column or recorded audit payload). They belong
 * in packages/contracts eventually; moving them there needs explicit approval.
 *
 * Rules every schema follows:
 *  - Every response is validated at runtime; anything that does not match is rejected, never "best-effort" shown.
 *  - Unknown keys are stripped, so an accidental extra field (e.g. a secret) can never reach the UI.
 *  - Text that originated outside the gate (reports, agent output, payloads) is length-capped and rendered as
 *    plain text only (UntrustedText).
 *  - Provenance is stated by the API for every fact; the console never infers it. "demo" is never accepted.
 *  - Fields the gate does not store today are nullable; the UI says they are unavailable instead of guessing.
 */

export const Timestamp = z.iso.datetime({ offset: true });

/** Machine-readable reason code. Known codes get labels (lib/reasons.ts); a newer code still renders verbatim. */
export const ReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "reason code");

/** "case.state_changed" etc. Known types (contracts AUDIT_EVENT_TYPES) get labels; newer ones render verbatim. */
export const EventType = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, "event type");

/** What the API may claim as a fact's source. DEMO is a design-reference concept and is never valid API data. */
export const ApiProvenance = z.enum(["github", "gate", "signed-verifier", "agent-claim"]);
export type ApiProvenance = z.infer<typeof ApiProvenance>;

const UntrustedText = (max: number) => z.string().max(max);

export const CaseStateSchema = z.enum(CASE_STATES);

// ---------------------------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------------------------

const caseSummaryShape = {
  id: CaseId,
  state: CaseStateSchema,
  repo: RepoSlug.optional(),
  repository: RepoSlug.optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  pullRequest: z.number().int().positive().nullable().optional(),
  pullRequestUrl: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  headSha: FullSha.nullable(),
  blockedReason: ReasonCode.nullable(),
  blockedReasonTransient: z.boolean().nullable().optional(),
  reporterId: z.string().optional(),
  reportExcerpt: UntrustedText(500),
  stateEnteredAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const CaseSummary = z.object(caseSummaryShape).transform((c) => {
  const repo = c.repository ?? c.repo ?? "repo";
  const pr = c.pullRequest ?? c.prNumber ?? null;
  return {
    ...c,
    repo,
    repository: repo,
    prNumber: pr,
    pullRequest: pr,
    branch: c.branch ?? null,
    blockedReasonTransient: c.blockedReasonTransient ?? null,
    pullRequestUrl: c.pullRequestUrl ?? (pr !== null ? `https://github.com/${repo}/pull/${pr}` : null),
  };
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const Commit = z.object({
  headSha: FullSha,
  baseSha: FullSha,
  observedAt: Timestamp,
  isCurrentHead: z.boolean().optional(),
  provenance: z.literal("github").default("github"),
}).transform((c) => ({
  ...c,
  isCurrentHead: c.isCurrentHead ?? true,
  provenance: "github" as const,
}));
export type Commit = z.infer<typeof Commit>;

export const CiCheck = z.object({
  id: z.string().min(1).max(100),
  headSha: FullSha,
  checkName: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  appSlug: z.string().min(1).max(100).optional(),
  source: z.string().min(1).max(100).optional(),
  status: z.string().min(1).max(40),
  conclusion: z.string().min(1).max(40).nullable(),
  /** Rendered as a link only after safeGitHubUrl(); otherwise plain text. */
  htmlUrl: z.string().max(500).optional(),
  url: z.string().max(500).nullable().optional(),
  observedAt: Timestamp,
  isCurrentHead: z.boolean().optional(),
  provenance: z.literal("github").default("github"),
}).transform((c) => {
  const name = c.checkName ?? c.name ?? "check";
  const source = c.appSlug ?? c.source ?? "github-actions";
  const url = c.htmlUrl ?? c.url ?? "";
  return {
    ...c,
    name,
    checkName: name,
    source,
    appSlug: source,
    htmlUrl: url,
    url: url || null,
    isCurrentHead: c.isCurrentHead ?? true,
    provenance: "github" as const,
  };
});
export type CiCheck = z.infer<typeof CiCheck>;

export const VERIFICATION_STATUSES = ["requested", "pass", "fail", "invalid", "timeout", "superseded"] as const;
export const SIGNATURE_STATUSES = ["valid", "absent", "unverified", "invalid"] as const;

const VerificationFinding = z.object({
  severity: z.enum(["info", "low", "medium", "high"]),
  file: z.string().max(300).nullable(),
  message: UntrustedText(500),
});

const verificationRunShape = {
  id: z.string().min(1).max(100),
  headSha: FullSha,
  status: z.enum(VERIFICATION_STATUSES),
  requestedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  sequence: z.number().int().positive().optional(),
  isCurrentHead: z.boolean().optional(),
  /** Gate verification mode when the run was recorded (audit payload `verification`); null if not recorded. */
  mode: z.enum(["advisory", "isolated"]).nullable().optional(),
  advisory: z.boolean().nullable().optional(),
  /** D28 signature check recorded by the gate (audit payload `signature`); null while requested. */
  signature: z.enum(SIGNATURE_STATUSES).nullable(),
  report: z.object({
    verdict: z.enum(["pass", "fail"]),
    regressionTestFailsBeforeFix: z.boolean(),
    summary: z.string(),
    findings: z.array(VerificationFinding),
  }).nullable().optional(),
  summary: UntrustedText(800).nullable().optional(),
  findings: z.array(VerificationFinding).max(30).optional(),
  regressionTestFailsBeforeFix: z.boolean().nullable().optional(),
  provenance: z.enum(["gate", "signed-verifier", "agent-claim"]).default("gate"),
};

/** Signed-verifier provenance is only credible with a valid signature: anything else is a contract violation. */
function signedMeansValid(run: { provenance?: string; signature: string | null }, ctx: z.RefinementCtx): void {
  if (run.provenance === "signed-verifier" && run.signature !== "valid") {
    ctx.addIssue({ code: "custom", path: ["provenance"], message: "signed-verifier provenance requires a valid signature" });
  }
}

export const VerificationRun = z.object(verificationRunShape).superRefine(signedMeansValid).transform((r) => {
  const mode = r.mode ?? (r.advisory === true ? "advisory" : r.advisory === false ? "isolated" : null);
  const summary = r.report ? r.report.summary : (r.summary ?? null);
  const findings = r.report ? r.report.findings : (r.findings ?? []);
  const regressionTestFailsBeforeFix = r.report ? r.report.regressionTestFailsBeforeFix : (r.regressionTestFailsBeforeFix ?? null);
  const prov = r.signature === "valid" ? ("signed-verifier" as const) : r.provenance;
  return {
    ...r,
    mode,
    advisory: r.advisory ?? (mode === "advisory"),
    summary,
    findings,
    regressionTestFailsBeforeFix,
    provenance: prov,
  };
});
export type VerificationRun = z.infer<typeof VerificationRun>;

export const VerificationRunListItem = z
  .object({ ...verificationRunShape, caseId: CaseId, caseState: CaseStateSchema, caseHeadSha: FullSha.nullable() })
  .superRefine(signedMeansValid).transform((r) => {
    const mode = r.mode ?? (r.advisory === true ? "advisory" : r.advisory === false ? "isolated" : null);
    const summary = r.report ? r.report.summary : (r.summary ?? null);
    const findings = r.report ? r.report.findings : (r.findings ?? []);
    const regressionTestFailsBeforeFix = r.report ? r.report.regressionTestFailsBeforeFix : (r.regressionTestFailsBeforeFix ?? null);
    const prov = r.signature === "valid" ? ("signed-verifier" as const) : r.provenance;
    return {
      ...r,
      mode,
      advisory: r.advisory ?? (mode === "advisory"),
      summary,
      findings,
      regressionTestFailsBeforeFix,
      provenance: prov,
    };
  });
export type VerificationRunListItem = z.infer<typeof VerificationRunListItem>;

export const Approval = z.object({
  id: z.string().min(1).max(100),
  approverId: ParticipantId,
  headSha: FullSha,
  decision: z.enum(["approve", "reject"]),
  reason: UntrustedText(500).nullable(),
  createdAt: Timestamp,
  provenance: z.literal("gate").default("gate"),
});
export type Approval = z.infer<typeof Approval>;

export const MergeOperation = z.object({
  id: z.string().min(1).max(100),
  headSha: FullSha,
  attempt: z.number().int().min(1),
  status: z.enum(["started", "succeeded", "failed", "unknown"]),
  githubMergeSha: FullSha.nullable().optional(),
  mergeSha: FullSha.nullable().optional(),
  /** Mapped to a reason code by the API; raw GitHub error text is never sent. */
  errorCode: ReasonCode.nullable().optional(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  provenance: z.enum(["gate", "github"]).default("gate"),
}).transform((m) => {
  const sha = m.githubMergeSha ?? m.mergeSha ?? null;
  return {
    ...m,
    githubMergeSha: sha,
    mergeSha: sha,
    errorCode: m.errorCode ?? null,
    provenance: m.provenance,
  };
});
export type MergeOperation = z.infer<typeof MergeOperation>;

export const GateDecision = z.object({
  outcome: z.enum(["allowed", "blocked"]),
  reasonCodes: z.array(ReasonCode).max(30),
  headSha: FullSha,
  observedAt: Timestamp,
  provenance: z.literal("gate"),
});
export type GateDecision = z.infer<typeof GateDecision>;

/** What the fixer agent said about its own work. Never verified by the console: always an agent claim. */
export const FixerClaim = z.object({
  outcome: z.enum(["fixed", "not_reproduced"]),
  headSha: FullSha.nullable(),
  testsRun: z.array(z.string().max(200)).max(50),
  regressionTest: z.string().max(300).nullable(),
  limitations: z.array(UntrustedText(500)).max(20),
  summary: UntrustedText(800).nullable(),
  reportedAt: Timestamp,
  provenance: z.literal("agent-claim"),
});
export type FixerClaim = z.infer<typeof FixerClaim>;

/** Gate-side snapshot of the pull request (R3: not stored today, so usually null). */
export const PrSnapshot = z.object({
  title: UntrustedText(300),
  author: z.string().max(100),
  url: z.string().max(500),
  changedFiles: z.array(z.string().max(300)).max(300),
  observedAt: Timestamp,
  provenance: z.literal("github"),
});
export type PrSnapshot = z.infer<typeof PrSnapshot>;

export const CaseDetail = z.object({
  ...caseSummaryShape,
  branch: z.string().max(255).nullable().optional(),
  reportText: UntrustedText(4000),
  commits: z.array(Commit).max(100).default([]),
  ciChecks: z.array(CiCheck).max(300).default([]),
  checks: z.array(CiCheck).optional(),
  verificationRuns: z.array(VerificationRun).max(100).default([]),
  latestVerification: VerificationRun.nullable().optional(),
  approvals: z.array(Approval).max(100).default([]),
  mergeOperations: z.array(MergeOperation).max(20).default([]),
  latestMerge: MergeOperation.nullable().optional(),
  /** R3: the full SHA the gate's latest passing verification is bound to. Selected server-side, never here. */
  evidence: z.object({ verifiedSha: FullSha, runId: z.string().min(1).max(100) }).nullable().default(null),
  lastGateDecision: GateDecision.nullable().default(null),
  fixerClaim: FixerClaim.nullable().default(null),
  prSnapshot: PrSnapshot.nullable().default(null),
}).transform((c) => {
  const repo = c.repository ?? c.repo ?? "repo";
  const pr = c.pullRequest ?? c.prNumber ?? null;
  const ciChecks = c.checks && c.checks.length > 0 ? c.checks : c.ciChecks;
  const verificationRuns = c.latestVerification
    ? [c.latestVerification, ...c.verificationRuns.filter((v: { id: string }) => v.id !== c.latestVerification?.id)]
    : c.verificationRuns;
  const mergeOperations = c.latestMerge
    ? [c.latestMerge, ...c.mergeOperations.filter((m: { id: string }) => m.id !== c.latestMerge?.id)]
    : c.mergeOperations;
  const passingRun = verificationRuns.find((r: { status: string }) => r.status === "pass");
  const evidence = c.evidence ?? (passingRun ? { verifiedSha: passingRun.headSha, runId: passingRun.id } : null);
  return {
    ...c,
    repo,
    repository: repo,
    prNumber: pr,
    pullRequest: pr,
    branch: c.branch ?? null,
    blockedReasonTransient: c.blockedReasonTransient ?? null,
    pullRequestUrl: c.pullRequestUrl ?? (pr !== null ? `https://github.com/${repo}/pull/${pr}` : null),
    ciChecks,
    checks: ciChecks,
    verificationRuns,
    mergeOperations,
    evidence,
  };
});
export type CaseDetail = z.infer<typeof CaseDetail>;

// ---------------------------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------------------------

export const AuditEvent = z.object({
  id: z.number().int().nonnegative(),
  caseId: CaseId.nullable(),
  actorId: z.string().min(1).max(256),
  type: z.string().optional(),
  eventType: EventType.optional(),
  targetSha: FullSha.nullable(),
  reasonCode: ReasonCode.nullable(),
  /** Redacted server-side; still UNTRUSTED and rendered as plain text only. */
  payload: z.record(z.string().max(100), z.unknown()),
  createdAt: Timestamp,
  provenance: ApiProvenance.default("gate"),
}).transform((e) => {
  const t = e.type ?? e.eventType ?? "case.state_changed";
  return {
    ...e,
    type: t,
    eventType: t,
    provenance: e.provenance,
  };
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---------------------------------------------------------------------------------------------------------------
// Overview, configuration, status
// ---------------------------------------------------------------------------------------------------------------

const Count = z.number().int().nonnegative();

export const Overview = z.object({
  /** Exhaustive over the 14 contract states; computed by the API. */
  countsByState: z.record(CaseStateSchema, Count),
  /** Cases the gate says are waiting on a maintainer or stuck; selection is server-side. */
  attention: z.array(CaseSummary).max(50),
  verification: z.object({
    windowDays: z.number().int().positive(),
    pass: Count, fail: Count, invalid: Count, timeout: Count, requested: Count, superseded: Count,
  }),
  recentActivity: z.array(AuditEvent).max(50),
});
export type Overview = z.infer<typeof Overview>;

/** Allowlisted, non-secret configuration. Keys outside this allowlist are stripped and never rendered. */
export const ConfigSummary = z.object({
  repo: RepoSlug,
  baseBranch: z.string().min(1).max(255),
  requiredChecks: z.array(z.string().min(1).max(200)).max(50),
  verificationMode: z.enum(["advisory", "isolated"]),
  safety: z.object({
    mergeEnabled: z.boolean(),
    privilegedEnabled: z.boolean(),
    verifierIsolationProven: z.boolean(),
  }),
  quorum: z.number().int().positive(),
  gateMention: z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/, "Switch mention"),
  schemaVersion: z.number().int().nonnegative(),
  pollIntervalMs: z.number().int().positive(),
  verifyTimeoutMs: z.number().int().positive(),
  fixTimeoutMs: z.number().int().positive(),
});
export type ConfigSummary = z.infer<typeof ConfigSummary>;

export const SystemStatus = z.object({
  ok: z.boolean(),
  /** Names of failing readiness checks only (the gate's /readyz); never error details. */
  failing: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)).max(30),
  checkedAt: Timestamp,
});
export type SystemStatus = z.infer<typeof SystemStatus>;

// ---------------------------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------------------------

/** Short machine names of sources that failed while assembling a response (partial data). */
export const SourceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const ResponseMeta = z.object({
  generatedAt: Timestamp,
  nextCursor: z.string().min(1).max(200).nullable().default(null),
  unavailable: z.array(SourceName).max(20).default([]),
});
export type ResponseMeta = z.infer<typeof ResponseMeta>;

export const ErrorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), message: z.string().max(500) }),
});

export function successEnvelope<S extends z.ZodType>(data: S) {
  return z.object({ success: z.literal(true), data, meta: ResponseMeta });
}

/** Page size the console requests for paginated lists; the API may return fewer. */
export const PAGE_SIZE = 50;
export const pageOf = <S extends z.ZodType>(item: S) => z.array(item).max(200);
