import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive identifiers
// ---------------------------------------------------------------------------

/** A full, lower-case, 40-hex-character commit SHA. Authorization always binds to this. */
export const FullSha = z.string().regex(/^[0-9a-f]{40}$/, "full 40-char SHA required");
export type FullSha = z.infer<typeof FullSha>;

export const CaseId = z.string().regex(/^LB-\d{3,}$/, "case id like LB-001");
export type CaseId = z.infer<typeof CaseId>;

/** Switch participant ids are opaque: match them, never parse them. */
export const ParticipantId = z.string().min(3).max(256);
export type ParticipantId = z.infer<typeof ParticipantId>;

export const RepoSlug = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repo")
  .refine((s) => s.split("/").every((seg) => seg !== "." && seg !== ".."), "owner/repo");
export type RepoSlug = z.infer<typeof RepoSlug>;

// ---------------------------------------------------------------------------
// Case states (implementation §8)
// ---------------------------------------------------------------------------

export const CASE_STATES = [
  "Reported", "Triaged", "FixInProgress", "PRCreated", "Verifying",
  "VerificationFailed", "AwaitingApproval", "ReadyToMerge", "Revalidating",
  "Merging", "Merged", "Stale", "Blocked", "MergeUnknown",
] as const;
export const CaseState = z.enum(CASE_STATES);
export type CaseState = (typeof CASE_STATES)[number];

// ---------------------------------------------------------------------------
// Inbound chat messages (§7, amended by D16: attribution is preserved, never defaulted)
// ---------------------------------------------------------------------------

export const InboundMessage = z.object({
  eventId: z.string().min(1),
  roomId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  messageId: z.string().min(1),
  sender: ParticipantId,
  /** Raw Switch sender_kind. No default: a missing value is treated as non-human (D16). */
  senderKind: z.string().min(1).nullable(),
  /** Raw Switch on_behalf_of. Any non-null value makes the message an agent message (D16). */
  onBehalfOf: z.string().min(1).nullable(),
  addressed: z.boolean(),
  body: z.string().max(20_000),
  threadId: z.string().min(1).nullable(),
  timestamp: z.number(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

// ---------------------------------------------------------------------------
// Commands (§10.4, plus retask from D10)
// ---------------------------------------------------------------------------

export const Command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("help") }),
  z.object({ kind: z.literal("whoami") }),
  z.object({ kind: z.literal("report"), text: z.string().min(10).max(4000) }),
  z.object({ kind: z.literal("status"), caseId: CaseId }),
  z.object({ kind: z.literal("verify"), caseId: CaseId }),
  // Approvals name the FULL commit SHA (D25, revised): no prefix is ever accepted as authorization.
  z.object({ kind: z.literal("approve"), caseId: CaseId, sha: FullSha }),
  z.object({ kind: z.literal("reject"), caseId: CaseId, reason: z.string().min(3).max(500) }),
  z.object({ kind: z.literal("merge"), caseId: CaseId }),
  z.object({ kind: z.literal("audit"), caseId: CaseId }),
  z.object({ kind: z.literal("retask"), caseId: CaseId, note: z.string().trim().min(1).max(500) }),
]);
export type Command = z.infer<typeof Command>;
export type CommandKind = Command["kind"];
export const COMMAND_KINDS: readonly CommandKind[] = [
  "help", "whoami", "report", "status", "verify", "approve", "reject", "merge", "audit", "retask",
];

// ---------------------------------------------------------------------------
// Agent reports (advisory; the gate re-reads GitHub). Strict: unknown keys are rejected.
// ---------------------------------------------------------------------------

const ReportText = z.string().max(500);

export const FixerReport = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("fixer"),
    status: z.literal("fixed"),
    caseId: CaseId,
    prUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/, "GitHub pull request URL"),
    headSha: FullSha,
    branch: z.string().regex(/^loopback\/LB-\d{3,}$/, "loopback/LB-nnn"),
    testsRun: z.array(z.string().max(200)).max(50),
    regressionTest: z.string().min(1).max(300),
    limitations: z.array(ReportText).max(20),
  }).strict(),
  z.object({
    type: z.literal("fixer"),
    status: z.literal("not_reproduced"),
    caseId: CaseId,
    testsRun: z.array(z.string().max(200)).max(50),
    limitations: z.array(ReportText).max(20),
    summary: z.string().max(800),
  }).strict(),
]);
export type FixerReport = z.infer<typeof FixerReport>;

export const VerifierReport = z.object({
  type: z.literal("verifier"),
  /** The verification run id the gate sent with the request (D25); binds the report to that run. */
  runId: z.string().uuid(),
  caseId: CaseId,
  repository: RepoSlug,
  pullRequest: z.number().int().positive(),
  headSha: FullSha,
  verdict: z.enum(["pass", "fail"]),
  findings: z.array(z.object({
    severity: z.enum(["info", "low", "medium", "high"]),
    file: z.string().max(300).optional(),
    message: ReportText,
  }).strict()).max(30),
  regressionTestFailsBeforeFix: z.boolean(),
  summary: z.string().max(800),
}).strict();
export type VerifierReport = z.infer<typeof VerifierReport>;

// ---------------------------------------------------------------------------
// Approvals (§7, D11: bound to repository, PR and full SHA)
// ---------------------------------------------------------------------------

export const Approval = z.object({
  caseId: CaseId,
  repository: RepoSlug,
  pullRequest: z.number().int().positive(),
  headSha: FullSha,
  approverId: ParticipantId,
  decision: z.enum(["approve", "reject"]),
  sourceEventId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Approval = z.infer<typeof Approval>;

// ---------------------------------------------------------------------------
// Audit events (§7 plus decision-driven additions)
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_TYPES = [
  "case.created", "case.state_changed", "fixer.started", "pr.created",
  "verification.started", "verification.passed", "verification.failed",
  "approval.accepted", "approval.rejected", "commit.changed", "merge.blocked",
  "merge.requested", "merge.confirmed", "merge.outcome_unknown",
  "command.refused", "agent_output.invalid", "ci.observed", "gate_status.posted",
  // D8/D9/D10/D14/D15 additions
  "gate_status.corrected", "gate_status.correction_failed", "case.retasked",
  "policy.violation", "retry.attempted", "fixer.reported",
] as const;
export const AuditEventType = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Reason codes (one shared enum for policy, audit and chat)
// ---------------------------------------------------------------------------

export const REASON_CODES = [
  // evaluateMerge
  "GITHUB_UNAVAILABLE", "IDENTITY_MISMATCH", "ALREADY_MERGED", "PR_CLOSED", "PR_DRAFT",
  "NOT_MERGEABLE", "MERGEABILITY_UNKNOWN", "WRONG_BASE", "BASE_UNPROTECTED",
  "PROTECTED_PATH_CHANGED", "HEAD_MOVED", "CI_MISSING", "CI_PENDING", "CI_FAILED",
  "VERIFICATION_MISSING", "VERIFICATION_PENDING", "VERIFICATION_STALE",
  "VERIFICATION_IDENTITY", "VERIFICATION_FAILED", "VERIFICATION_INVALID",
  "VERIFICATION_TIMEOUT", "REJECTED", "APPROVAL_STALE", "APPROVAL_MISSING",
  // approvals and router
  "APPROVAL_SHA_MISMATCH", "NOT_AUTHORIZED", "UNKNOWN_COMMAND", "CASE_NOT_FOUND",
  "INVALID_STATE", "PRIVILEGED_DISABLED",
  // merge service
  "MERGE_DISABLED", "CONFIG_INCOMPLETE", "MERGE_OUTCOME_UNKNOWN", "AWAITING_MERGE_COMMAND",
  "RETRY_LIMIT_REACHED", "MERGE_ATTEMPTS_EXHAUSTED",
  // case lifecycle
  "NOT_REPRODUCED", "FIXER_TIMEOUT", "BASE_COMMIT_MISMATCH", "AGENT_OUTPUT_INVALID",
  // GitHub client
  "RATE_LIMITED",
] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = (typeof REASON_CODES)[number];

/** The approved transient codes (D15). Every other code is terminal. */
export const TRANSIENT_REASON_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "CI_PENDING", "GITHUB_UNAVAILABLE", "RATE_LIMITED", "MERGEABILITY_UNKNOWN",
  "VERIFICATION_PENDING", "AWAITING_MERGE_COMMAND",
]);

export function isTransient(code: ReasonCode): boolean {
  return TRANSIENT_REASON_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First 12 hex characters, for display only — never accepted as input for authorization. */
export function displaySha(sha: string): string {
  return sha.slice(0, 12);
}
