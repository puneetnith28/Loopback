import type { ReasonCode } from "@loopback/contracts";

/** Context for refusal messages. Every value is rendered through `safe()`. */
export interface ReasonContext {
  readonly caseId?: string;
  readonly command?: string;
  readonly sender?: string;
  readonly approvedSha?: string;
  readonly headSha?: string;
  readonly check?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly detail?: string;
}

type Prefix = "BLOCKED" | "REFUSED" | "UNKNOWN" | "STOPPED";

/** Neutralise Markdown/mention syntax in untrusted values before they reach chat. */
export function safe(value: string | undefined, max = 200): string {
  if (value === undefined) return "?";
  // Drop control and bidirectional-override characters, which can visually spoof ids.
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ");
  const chars = Array.from(cleaned); // code points: never split a surrogate pair
  const clipped = chars.length > max ? `${chars.slice(0, max).join("")}…` : cleaned;
  return clipped
    .replace(/[`*_~|<>[\]\\&#!]/g, (c) => `\\${c}`)
    .replace(/@/g, "@​")
    .replace(/\s+/g, " ");
}
const s12 = (sha: string | undefined) => (sha ? safe(sha.slice(0, 12)) : "?");

// One entry per ReasonCode; the Record type makes a missing code a compile error.
const REASONS: Readonly<Record<ReasonCode, readonly [Prefix, (c: ReasonContext) => string]>> = {
  GITHUB_UNAVAILABLE: ["BLOCKED", () => "Could not read current PR state. Loopback does not merge on cached evidence."],
  IDENTITY_MISMATCH: ["BLOCKED", () => "The PR on GitHub does not match this case."],
  ALREADY_MERGED: ["BLOCKED", () => "The PR is already merged."],
  PR_CLOSED: ["BLOCKED", () => "The PR is closed."],
  PR_DRAFT: ["BLOCKED", () => "The PR is a draft."],
  NOT_MERGEABLE: ["BLOCKED", () => "GitHub reports the PR is not mergeable."],
  MERGEABILITY_UNKNOWN: ["BLOCKED", () => "GitHub has not determined whether the PR is mergeable yet. Try merge again shortly."],
  WRONG_BASE: ["BLOCKED", (c) => `The PR does not target the configured base branch. ${safe(c.detail)}`],
  BASE_UNPROTECTED: ["BLOCKED", () => "Required branch protection is not active on the base branch. No merge was attempted."],
  PROTECTED_PATH_CHANGED: ["BLOCKED", (c) => `The PR changes protected files (CI, dependencies or test configuration). ${safe(c.detail)}`],
  HEAD_MOVED: ["BLOCKED", (c) => `The PR now points to ${s12(c.headSha)}. Evidence for the previous commit does not apply.`],
  CI_MISSING: ["BLOCKED", (c) => `Required check "${safe(c.check)}" has no run for ${s12(c.headSha)}.`],
  CI_PENDING: ["BLOCKED", (c) => `Required check "${safe(c.check)}" is still running for ${s12(c.headSha)}.`],
  CI_FAILED: ["BLOCKED", (c) => `Required check "${safe(c.check)}" concluded ${safe(c.conclusion)} for ${s12(c.headSha)}.`],
  VERIFICATION_MISSING: ["BLOCKED", () => "No verifier result is recorded."],
  VERIFICATION_PENDING: ["BLOCKED", (c) => `Verification of ${s12(c.headSha)} has not completed.`],
  VERIFICATION_STALE: ["BLOCKED", (c) => `Verification is for an older commit, not ${s12(c.headSha)}. Re-verifying.`],
  VERIFICATION_IDENTITY: ["BLOCKED", () => "Verifier evidence is for a different PR."],
  VERIFICATION_FAILED: ["BLOCKED", () => "The verifier's verdict is fail."],
  VERIFICATION_INVALID: ["BLOCKED", () => "The latest verifier output was not a valid loopback-report."],
  VERIFICATION_TIMEOUT: ["BLOCKED", () => "The latest verification timed out and counts as not passed."],
  REJECTED: ["BLOCKED", () => "A maintainer rejected this revision."],
  APPROVAL_STALE: ["BLOCKED", (c) =>
    `The maintainer approved commit ${s12(c.approvedSha)}, but the PR now points to ${s12(c.headSha)}. ` +
    `The old approval and verification do not authorize ${s12(c.headSha)}. No merge was attempted. ` +
    `Re-verifying ${s12(c.headSha)}; approve again when it is ready. Recorded in the ${safe(c.caseId)} audit log.`],
  APPROVAL_MISSING: ["BLOCKED", (c) => `No maintainer approval for ${s12(c.headSha)} yet.`],
  APPROVAL_SHA_MISMATCH: ["REFUSED", (c) => `You approved ${s12(c.approvedSha)} but the PR is at ${s12(c.headSha)}.`],
  NOT_AUTHORIZED: ["REFUSED", (c) =>
    `${safe(c.command)} requires the maintainer role. Your id ${safe(c.sender)} is not on the maintainer list. Recorded.`],
  UNKNOWN_COMMAND: ["REFUSED", (c) => `Unrecognised command. ${safe(c.detail)}`],
  CASE_NOT_FOUND: ["REFUSED", (c) => `No case ${safe(c.caseId)} exists.`],
  INVALID_STATE: ["REFUSED", (c) => `${safe(c.command)} is not possible while ${safe(c.caseId)} is ${safe(c.state)}.`],
  PRIVILEGED_DISABLED: ["REFUSED", (c) =>
    `${safe(c.command)} is disabled until maintainer identity attribution is verified on this Switch install.`],
  MERGE_DISABLED: ["BLOCKED", () => "Merging is disabled (read-only mode)."],
  CONFIG_INCOMPLETE: ["BLOCKED", () => "Loopback is not fully configured; merging is disabled."],
  MERGE_OUTCOME_UNKNOWN: ["UNKNOWN", () => "The merge request did not return a clear result. Checking GitHub before doing anything else."],
  AWAITING_MERGE_COMMAND: ["STOPPED", (c) =>
    `Revalidation of ${s12(c.headSha)} passed after reconciliation. A maintainer must send merge again to proceed.`],
  RETRY_LIMIT_REACHED: ["BLOCKED", () => "The retry limit for this commit has been reached."],
  MERGE_ATTEMPTS_EXHAUSTED: ["BLOCKED", () => "The maximum number of merge attempts for this commit has been reached."],
  NOT_REPRODUCED: ["STOPPED", () => "The fixer could not reproduce the bug. A maintainer can retask with a note."],
  FIXER_TIMEOUT: ["STOPPED", () => "No pull request appeared before the fixer timeout. A maintainer can retask with a note."],
  BASE_COMMIT_MISMATCH: ["BLOCKED", () => "The demo base branch is not at its expected commit. Merging is disabled for this run."],
  AGENT_OUTPUT_INVALID: ["REFUSED", (c) => `Agent output did not contain a valid loopback-report block. ${safe(c.detail)}`],
  RATE_LIMITED: ["BLOCKED", () => "GitHub rate limit reached. Try merge again after the limit resets."],
};

export function formatReason(code: ReasonCode, ctx: ReasonContext = {}): string {
  const [prefix, render] = REASONS[code];
  return `${prefix} (${code}): ${render(ctx)}`;
}

export function reasonPrefix(code: ReasonCode): Prefix {
  return REASONS[code][0];
}
