/**
 * DEMONSTRATION FIXTURES — not real data. Imported only by the /design reference, which exists only in
 * dev / `--mode design` builds. tests/demo-isolation.test.ts builds production and asserts DEMO_SENTINEL is
 * absent from every emitted file. Lint forbids importing src/demo from anywhere else.
 */
import type { CaseState } from "@loopback/contracts";
import type { TimelineEvent } from "../design-system/components/Timeline.tsx";
import type { Status } from "../design-system/components/Badge.tsx";

export const DEMO_SENTINEL = "loopback-demo-fixture-7f3a";

/** Fixed clock so relative times are stable. */
export const DEMO_NOW = new Date("2026-11-04T14:30:00Z");

export const DEMO_HEAD = "e804775a5938f9afe55fa5321875735734e3e1a5";
export const DEMO_OLD_HEAD = "70a5362de6f0ae97b11b83c4406d6316433daa8d";
export const DEMO_MOVED_HEAD = "b41c9e07d2a8f3165e0c7b9a4d6f2e8c1a3b5d70";

export interface DemoCase {
  readonly id: string;
  readonly summary: string;
  readonly state: CaseState;
  readonly verification: Status;
  readonly head: string | null;
  readonly updated: string;
  readonly sentinel: typeof DEMO_SENTINEL;
}

export const DEMO_CASES: readonly DemoCase[] = [
  { id: "LB-042", summary: "formatToken throws TypeError when the replace mapping contains null", state: "AwaitingApproval", verification: "verified", head: DEMO_HEAD, updated: "2026-11-04T14:18:00Z", sentinel: DEMO_SENTINEL },
  { id: "LB-041", summary: "Slugify drops trailing digits after a unicode dash", state: "Verifying", verification: "running", head: DEMO_OLD_HEAD, updated: "2026-11-04T14:02:00Z", sentinel: DEMO_SENTINEL },
  { id: "LB-039", summary: "Locale fallback ignores region subtags", state: "Stale", verification: "pending", head: DEMO_MOVED_HEAD, updated: "2026-11-04T12:40:00Z", sentinel: DEMO_SENTINEL },
  { id: "LB-037", summary: "Parser accepts unterminated escape at end of input", state: "VerificationFailed", verification: "failed", head: "3f9a1c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a", updated: "2026-11-04T09:15:00Z", sentinel: DEMO_SENTINEL },
  { id: "LB-033", summary: "Reporter text with a hidden direction override‮ fdp.exe", state: "Reported", verification: "pending", head: null, updated: "2026-11-03T21:05:00Z", sentinel: DEMO_SENTINEL },
  { id: "LB-030", summary: "Cache key collides for paths differing only in case", state: "Merged", verification: "verified", head: "9c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e", updated: "2026-11-02T16:47:00Z", sentinel: DEMO_SENTINEL },
];

export const DEMO_EVENTS: readonly TimelineEvent[] = [
  { id: "d1", kind: "human", title: "Report triaged and fixer tasked", actor: "@maintainer", at: "2026-11-04T13:02:00Z", provenance: "gate" },
  { id: "d2", kind: "machine", title: "Fixer opened a pull request", actor: "@loopback-fixer", at: "2026-11-04T13:41:00Z", provenance: "agent-claim", detail: "Added regression test test/index.test.js › handles null replacement; 6 tests pass locally." },
  { id: "d3", kind: "github", title: "Pull request #2 observed at head e804775", actor: "github.com", at: "2026-11-04T13:43:00Z", provenance: "github" },
  { id: "d4", kind: "github", title: "CI check “test” completed: success", actor: "github-actions", at: "2026-11-04T13:49:00Z", provenance: "github" },
  { id: "d5", kind: "verification", title: "Verifier report accepted for e804775", actor: "@loopback-verifier", at: "2026-11-04T14:11:00Z", provenance: "signed-verifier", detail: "Regression test fails at 70a5362 (TypeError) and passes at e804775. 6/6 tests pass in the runner sandbox." },
  { id: "d6", kind: "gate", title: "Case moved to Awaiting approval", actor: "loopback-gate", at: "2026-11-04T14:11:30Z", provenance: "gate" },
  { id: "d7", kind: "failure", title: "Earlier verification run timed out", actor: "loopback-gate", at: "2026-11-04T12:20:00Z", provenance: "gate" },
  { id: "d8", kind: "rejection", title: "Approval refused: SHA did not match the head", actor: "@maintainer", at: "2026-11-04T12:31:00Z", provenance: "gate", detail: "approve LB-039 70a5362 → APPROVAL_SHA_MISMATCH" },
];
