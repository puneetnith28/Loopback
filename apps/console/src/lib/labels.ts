import type { AuditEventType } from "@loopback/contracts";
import type { EventKind } from "../design-system/components/Timeline.tsx";

/**
 * Human labels for machine values. Display only: nothing here changes what a value means. Unknown values (a newer
 * gate) fall back to the raw value, never to a guess.
 */
export const EVENT_LABELS: Readonly<Record<AuditEventType, string>> = {
  "case.created": "Case created",
  "case.state_changed": "Case state changed",
  "fixer.started": "Fixer started",
  "pr.created": "Pull request created",
  "verification.started": "Verification requested",
  "verification.passed": "Verification passed",
  "verification.failed": "Verification failed",
  "verification.superseded": "Verification superseded",
  "approval.accepted": "Approval accepted",
  "approval.rejected": "Approval rejected",
  "commit.changed": "Head commit changed",
  "merge.blocked": "Merge blocked",
  "merge.requested": "Merge requested",
  "merge.confirmed": "Merge confirmed",
  "merge.outcome_unknown": "Merge outcome unknown",
  "command.refused": "Command refused",
  "agent_output.invalid": "Agent output rejected",
  "ci.observed": "CI observed",
  "gate_status.posted": "Gate status posted",
  "gate_status.corrected": "Gate status corrected",
  "gate_status.correction_failed": "Gate status correction failed",
  "case.retasked": "Case retasked",
  "policy.violation": "Policy violation",
  "retry.attempted": "Retry attempted",
  "fixer.reported": "Fixer reported",
  "case.triaged": "Case triaged",
  "delivery.gap": "Switch delivery gap",
};

export function eventLabel(type: string): string {
  return (EVENT_LABELS as Readonly<Record<string, string>>)[type] ?? type;
}

const FAILURE = new Set(["verification.failed", "merge.outcome_unknown", "agent_output.invalid", "policy.violation", "gate_status.correction_failed", "delivery.gap"]);
const REJECTION = new Set(["approval.rejected", "command.refused", "merge.blocked"]);

/** Timeline category: who or what acted. Purely presentational. */
export function eventKind(type: string): EventKind {
  if (FAILURE.has(type)) return "failure";
  if (REJECTION.has(type)) return "rejection";
  if (type.startsWith("verification.")) return "verification";
  if (type.startsWith("approval.") || type === "case.triaged") return "human";
  if (type.startsWith("fixer.") || type === "pr.created" || type === "case.retasked") return "machine";
  if (type === "ci.observed" || type === "commit.changed") return "github";
  return "gate";
}

/** Agent-facing event types (the Agent activity screen). */
export const AGENT_EVENT_TYPES = {
  fixer: ["fixer.started", "fixer.reported", "pr.created", "case.retasked"],
  verifier: ["verification.started", "verification.passed", "verification.failed", "verification.superseded"],
  rejected: ["agent_output.invalid", "policy.violation"],
} as const satisfies Readonly<Record<string, readonly AuditEventType[]>>;

/** Gate-decision event types (the Gate & verification screen). */
export const GATE_EVENT_TYPES = [
  "approval.accepted", "approval.rejected", "merge.blocked", "merge.requested", "merge.confirmed",
  "merge.outcome_unknown", "command.refused", "gate_status.posted", "gate_status.corrected",
] as const satisfies readonly AuditEventType[];

const REASONS: Readonly<Record<string, string>> = {
  GITHUB_UNAVAILABLE: "GitHub was unavailable",
  HEAD_MOVED: "The head commit moved",
  CI_MISSING: "A required CI check is missing",
  CI_PENDING: "Required CI is still running",
  CI_FAILED: "Required CI failed",
  VERIFICATION_MISSING: "No verification for this commit",
  VERIFICATION_PENDING: "Verification is still running",
  VERIFICATION_STALE: "Verification is for an earlier commit",
  VERIFICATION_FAILED: "Verification failed",
  VERIFICATION_INVALID: "The verification report was invalid",
  VERIFICATION_TIMEOUT: "Verification timed out",
  VERIFICATION_ADVISORY: "Verification is advisory only",
  VERIFIER_SIGNATURE_INVALID: "The verifier signature was not valid",
  APPROVAL_MISSING: "No maintainer approval yet",
  APPROVAL_STALE: "The approval is for an earlier commit",
  APPROVAL_SHA_MISMATCH: "The approval named a different commit",
  REJECTED: "A maintainer rejected the change",
  PROTECTED_PATH_CHANGED: "A protected path changed",
  MERGE_DISABLED: "Merging is disabled",
  MERGE_OUTCOME_UNKNOWN: "The merge outcome is unknown",
  NOT_MERGEABLE: "GitHub reports the PR is not mergeable",
  MERGEABILITY_UNKNOWN: "GitHub has not computed mergeability",
  PR_CLOSED: "The pull request is closed",
  PR_DRAFT: "The pull request is a draft",
  WRONG_BASE: "The PR targets the wrong base branch",
  BASE_UNPROTECTED: "The base branch is not protected",
  NOT_AUTHORIZED: "Not authorized",
  PRIVILEGED_DISABLED: "Privileged commands are disabled",
  GATE_HALTED: "The gate halted",
  NOT_REPRODUCED: "The fixer could not reproduce the bug",
  FIXER_TIMEOUT: "The fixer timed out",
  RATE_LIMITED: "Rate limited",
};

export function reasonLabel(code: string): string {
  return REASONS[code] ?? code;
}

const SOURCES: Readonly<Record<string, string>> = {
  github: "GitHub observations",
  "github-snapshot": "the GitHub pull-request snapshot",
  "verification-runs": "verification runs",
  audit: "the audit log",
  config: "configuration",
  status: "gate readiness",
};

export function sourceLabel(name: string): string {
  return SOURCES[name] ?? name;
}
