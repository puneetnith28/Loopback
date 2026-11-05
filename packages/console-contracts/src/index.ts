import { AuditEventType, CaseId, CaseState, FullSha, GateSettings, ReasonCode, RepoSlug } from "@loopback/contracts";
import { z } from "zod";

// The wire contract of the read-only console API (docs/console-api.md). The server parses every
// response through these schemas before sending it, so a field not declared here cannot leave
// the API. The console can import the schemas and types directly.

export const API_VERSION = "v1";

const Timestamp = z.string().datetime();
const Sha = FullSha;
/** Text that came from outside (reports, agent output). Always render it as plain text, never HTML. */
const UntrustedText = z.string();
const GitHubUrl = z.string().regex(/^https:\/\/github\.com\//, "must be a github.com URL");

// ---------------------------------------------------------------- errors

export const API_ERROR_CODES = [
  "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "METHOD_NOT_ALLOWED",
  "DATABASE_UNAVAILABLE", "SCHEMA_MISMATCH", "INTERNAL",
] as const;
export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Every non-2xx response has this body. `requestId` matches the `x-request-id` header. */
export const ApiError = z.object({
  error: z.object({ code: ApiErrorCode, message: z.string(), requestId: z.string() }).strict(),
}).strict();
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------- query parameters

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;
const Limit = z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT);
const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,15})$/, "cursor must be a value returned by this API, or 0");

export const CaseListQuery = z.object({ state: CaseState.optional(), limit: Limit, cursor: Cursor.optional() }).strict();
export const AuditQuery = z.object({
  /** Newest first when absent; with `after`, oldest first from there: the way to poll for new events. */
  after: Cursor.optional(),
  before: Cursor.optional(),
  limit: Limit,
  type: AuditEventType.optional(),
  caseId: CaseId.optional(),
}).strict().refine((q) => q.after === undefined || q.before === undefined, "use either after or before");
export const ActivityQuery = z.object({ after: Cursor.optional(), before: Cursor.optional(), limit: Limit }).strict()
  .refine((q) => q.after === undefined || q.before === undefined, "use either after or before");
export const NoQuery = z.object({}).strict();

// ---------------------------------------------------------------- records

/** A short case row for tables and boards. `reportExcerpt` is untrusted text. */
export const CaseSummary = z.object({
  id: CaseId,
  state: CaseState,
  blockedReason: ReasonCode.nullable(),
  blockedReasonTransient: z.boolean().nullable(),
  repository: RepoSlug,
  pullRequest: z.number().int().positive().nullable(),
  pullRequestUrl: GitHubUrl.nullable(),
  branch: z.string().nullable(),
  headSha: Sha.nullable(),
  reporterId: z.string(),
  reportExcerpt: UntrustedText,
  stateEnteredAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).strict();
export type CaseSummary = z.infer<typeof CaseSummary>;

export const CommitRecord = z.object({
  headSha: Sha,
  baseSha: Sha,
  observedAt: Timestamp,
  isCurrentHead: z.boolean(),
}).strict();
export type CommitRecord = z.infer<typeof CommitRecord>;

export const VERIFICATION_STATUSES = ["requested", "pass", "fail", "invalid", "timeout", "superseded"] as const;
export const VerificationFinding = z.object({
  severity: z.enum(["info", "low", "medium", "high"]),
  file: UntrustedText.nullable(),
  message: UntrustedText,
}).strict();
/** The verifier's report. Agent output: untrusted text, even when signed. */
export const VerificationReport = z.object({
  verdict: z.enum(["pass", "fail"]),
  regressionTestFailsBeforeFix: z.boolean(),
  summary: UntrustedText,
  findings: z.array(VerificationFinding),
}).strict();
export const VerificationRun = z.object({
  id: z.string(),
  /** Monotonic: the highest `sequence` on a head is the run the gate counts. */
  sequence: z.number().int().positive(),
  headSha: Sha,
  isCurrentHead: z.boolean(),
  status: z.enum(VERIFICATION_STATUSES),
  /**
   * What the gate recorded about the report's signature. `valid` proves it came from the signer
   * and was not altered, not that the tests ran. `absent`: unsigned. `unverified`: signed, but the
   * gate had no public key to check it with. `null`: no report was recorded for this run.
   */
  signature: z.enum(["valid", "absent", "unverified", "invalid"]).nullable(),
  /** True when the gate labelled this verification advisory (isolation not proven). */
  advisory: z.boolean().nullable(),
  report: VerificationReport.nullable(),
  requestedAt: Timestamp,
  completedAt: Timestamp.nullable(),
}).strict();
export type VerificationRun = z.infer<typeof VerificationRun>;

/** A CI check the gate's poller read from GitHub. It is what was last seen: compare `observedAt`. */
export const CiCheck = z.object({
  id: z.string(),
  headSha: Sha,
  isCurrentHead: z.boolean(),
  name: z.string(),
  source: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: GitHubUrl.nullable(),
  observedAt: Timestamp,
}).strict();
export type CiCheck = z.infer<typeof CiCheck>;

export const ApprovalRecord = z.object({
  id: z.string(),
  approverId: z.string(),
  headSha: Sha,
  isCurrentHead: z.boolean(),
  decision: z.enum(["approve", "reject"]),
  reason: UntrustedText.nullable(),
  createdAt: Timestamp,
}).strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export const MergeOperation = z.object({
  id: z.string(),
  headSha: Sha,
  attempt: z.number().int().positive(),
  status: z.enum(["started", "succeeded", "failed", "unknown"]),
  mergeSha: Sha.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
}).strict();
export type MergeOperation = z.infer<typeof MergeOperation>;

export const AuditEvent = z.object({
  /** Monotonic; use it as the `after` cursor to poll. */
  id: z.number().int().positive(),
  caseId: CaseId.nullable(),
  actorId: z.string(),
  type: AuditEventType,
  targetSha: Sha.nullable(),
  reasonCode: ReasonCode.nullable(),
  /** Event-specific details, re-redacted by this API. May hold untrusted text. */
  payload: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
}).strict();
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Everything about one case on the current head, for a detail page. */
export const CaseDetail = CaseSummary.extend({
  /** Untrusted: from whoever filed the report. Plain text only. */
  reportText: UntrustedText,
  latestVerification: VerificationRun.nullable(),
  /** The newest observation of each check on the current head. */
  checks: z.array(CiCheck),
  /** Decisions on the current head only: a head change voids earlier ones. */
  approvals: z.array(ApprovalRecord),
  latestMerge: MergeOperation.nullable(),
}).strict();
export type CaseDetail = z.infer<typeof CaseDetail>;

// ---------------------------------------------------------------- envelopes

export const Page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
export const List = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) }).strict();

export const CaseListResponse = Page(CaseSummary);
export type CaseListResponse = z.infer<typeof CaseListResponse>;
export const AuditPageResponse = Page(AuditEvent);
export type AuditPageResponse = z.infer<typeof AuditPageResponse>;
export const CommitListResponse = List(CommitRecord);
export const VerificationListResponse = List(VerificationRun);
export const CiListResponse = List(CiCheck);
export const ApprovalListResponse = List(ApprovalRecord);
export const MergeListResponse = List(MergeOperation);

export const HealthResponse = z.object({ status: z.literal("ok") }).strict();
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SummaryResponse = z.object({
  totalCases: z.number().int().nonnegative(),
  byState: z.record(CaseState, z.number().int().nonnegative()),
  /** Not in a terminal state. */
  active: z.number().int().nonnegative(),
  /** Blocked, MergeUnknown, VerificationFailed or Stale: a person probably has to act. */
  needsAttention: z.number().int().nonnegative(),
  /** Verification runs requested in the window, each counted once by its current status. */
  verification: z.object({
    windowDays: z.number().int().positive(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    timeout: z.number().int().nonnegative(),
    requested: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
  }).strict(),
  lastEventAt: Timestamp.nullable(),
  generatedAt: Timestamp,
}).strict();
export type SummaryResponse = z.infer<typeof SummaryResponse>;

/** The gate's own /healthz and /readyz, read locally. Says nothing about the safety flags. */
export const GateStatusResponse = z.object({
  reachable: z.boolean(),
  live: z.boolean(),
  ready: z.boolean(),
  /** Names of the failing readiness checks. */
  failing: z.array(z.string()),
  checkedAt: Timestamp,
}).strict();
export type GateStatusResponse = z.infer<typeof GateStatusResponse>;

export const MetaResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  schemaVersion: z.number().int().positive(),
  caseStates: z.array(CaseState),
  auditEventTypes: z.array(AuditEventType),
  reasonCodes: z.array(z.object({ code: ReasonCode, transient: z.boolean() }).strict()),
  /** The audit event types `/activity` reports. */
  agentActivityTypes: z.array(AuditEventType),
}).strict();
export type MetaResponse = z.infer<typeof MetaResponse>;

/** `/config/summary`: the settings the gate recorded when it last started. In the console's envelope. */
export const ConfigSummaryResponse = z.object({
  success: z.literal(true),
  data: GateSettings.extend({ schemaVersion: z.number().int().positive() }).strict(),
  meta: z.object({ generatedAt: Timestamp }).strict(),
}).strict();
export type ConfigSummaryResponse = z.infer<typeof ConfigSummaryResponse>;

/** Audit events that describe agent work. There is no live session data: this is all that is recorded. */
export const AGENT_ACTIVITY_TYPES = [
  "fixer.started", "fixer.reported", "pr.created", "commit.changed",
  "verification.started", "verification.passed", "verification.failed", "verification.superseded",
  "agent_output.invalid", "case.retasked",
] as const satisfies readonly AuditEventType[];

/** The only state a case never leaves. A `Blocked` case can still be retasked. */
export const TERMINAL_STATES = ["Merged"] as const satisfies readonly CaseState[];
export const ATTENTION_STATES = ["Blocked", "MergeUnknown", "VerificationFailed", "Stale"] as const satisfies readonly CaseState[];
