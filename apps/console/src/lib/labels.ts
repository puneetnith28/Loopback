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

const REASON_GUIDANCE: Readonly<Record<string, string>> = {
  FIXER_TIMEOUT: "The fixer exceeded its time limit without opening a PR. Retask the case or investigate the fixer agent.",
  VERIFICATION_TIMEOUT: "The verifier exceeded its execution deadline. Check the verifier agent status or trigger re-verification.",
  HEAD_MOVED: "The pull request head commit changed after verification or approval. Verification and maintainer approval must run again for the new head.",
  CI_FAILED: "One or more required CI status checks failed on GitHub. Inspect the CI check runs and push a fix.",
  CI_MISSING: "Required CI checks have not reported status yet. Await completion or trigger CI workflows.",
  CI_PENDING: "Required CI checks are currently in progress. Wait for workflows to finish.",
  PROTECTED_PATH_CHANGED: "Changes touched protected configuration or security paths. Review carefully and ensure compliance with repository security policy.",
  NOT_REPRODUCED: "The fixer agent could not reproduce the reported bug. Check report details and provide additional reproduction steps or retask.",
  TRIAGE_DECLINED: "A maintainer reviewed and declined this report during triage.",
  BASE_COMMIT_MISMATCH: "The PR base branch or commit diverged from the expected target branch. Rebase the PR against the latest base.",
  VERIFICATION_FAILED: "The verifier evaluated the patch and reported a failure (e.g. regression test failed or high severity issue detected).",
  VERIFIER_SIGNATURE_INVALID: "The verifier cryptographic signature could not be verified by the signer public key.",
  APPROVAL_MISSING: "A maintainer has not yet approved this pull request head SHA in Switch.",
  APPROVAL_SHA_MISMATCH: "The approved SHA does not match the current PR head commit SHA.",
  MERGE_DISABLED: "Autonomous merge is disabled by configuration (MERGE_ENABLED=false). Maintainer manual merge or configuration change required.",
  GATE_HALTED: "The gate has entered a halted state due to an administrative or safety trip. An operator must resume the gate.",
  RATE_LIMITED: "GitHub API rate limit was encountered. Wait for the rate limit window to reset.",
  NOT_MERGEABLE: "GitHub reports merge conflicts. Rebase or merge base branch into the PR branch.",
};

export function reasonGuidance(code: string): string | null {
  return REASON_GUIDANCE[code] ?? null;
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
