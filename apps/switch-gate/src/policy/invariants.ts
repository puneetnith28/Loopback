import { FullSha } from "@loopback/contracts";

export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolation";
  }
}

/** Invariant 2: authorization state only ever stores full SHAs. */
export function assertFullSha(value: unknown, label: string): asserts value is string {
  if (!FullSha.safeParse(value).success) throw new InvariantViolation(`${label} must be a full 40-character SHA`);
}

/** Invariant 3: evidence must name the case's repository and PR. */
export function assertEvidenceIdentity(
  evidence: { readonly repository: string | null; readonly prNumber: number | null },
  expected: { readonly repo: string; readonly prNumber: number },
): void {
  if (evidence.repository !== expected.repo || evidence.prNumber !== expected.prNumber) {
    throw new InvariantViolation("evidence does not identify the case repository and PR");
  }
}
