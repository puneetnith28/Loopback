import type { AuditRow } from "../audit/index.js";
import type { CaseRecord } from "../persistence/repos.js";
import { safe } from "./reasons.js";

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "none");

export interface StatusFacts {
  readonly ci: ReadonlyArray<{ readonly name: string; readonly status: string | null; readonly conclusion: string | null }>;
  readonly verification: { readonly status: string; readonly headSha: string } | null;
  readonly approvals: number;
  readonly quorum: number;
}

function ciMark(status: string | null, conclusion: string | null): string {
  if (status === null) return "none";
  if (status !== "completed") return "pending";
  return conclusion === "success" ? "✅" : `❌ ${safe(conclusion ?? "unknown", 30)}`;
}

/** One-line case status, built only from persisted state (§13). */
export function renderStatus(c: CaseRecord, f: StatusFacts): string {
  const parts = [c.id, c.state];
  if (c.state === "Blocked" && c.blockedReason) parts.push(`reason ${c.blockedReason}`);
  parts.push(c.prNumber !== null ? `PR #${c.prNumber}` : "no PR yet");
  parts.push(`head ${short(c.headSha)}`);
  for (const ci of f.ci) parts.push(`CI ${safe(ci.name, 40)} ${ciMark(ci.status, ci.conclusion)}`);
  if (f.verification) {
    const mark = f.verification.status === "pass" ? "✅" : f.verification.status === "requested" ? "pending" : `❌ ${f.verification.status}`;
    parts.push(`verifier ${mark} (${short(f.verification.headSha)})`);
  } else {
    parts.push("verifier none");
  }
  parts.push(`approvals ${f.approvals}/${f.quorum}`);
  return parts.join(" · ");
}

/** Newest audit events as a Markdown table; every cell is escaped. */
export function renderAuditTable(caseId: string, rows: readonly AuditRow[]): string {
  if (rows.length === 0) return `No audit events for ${caseId}.`;
  const header = "| time (UTC) | actor | event | sha | reason |\n|---|---|---|---|---|";
  const body = rows
    .map((r) =>
      `| ${r.createdAt.slice(0, 19).replace("T", " ")} | ${safe(r.actorId, 60)} | ${safe(r.type, 40)} | ${short(r.targetSha)} | ${r.reasonCode ? safe(r.reasonCode, 40) : ""} |`,
    )
    .join("\n");
  return `Audit for ${caseId} (newest first):\n${header}\n${body}`;
}
