import { createHash } from "node:crypto";
import { displaySha } from "@loopback/contracts";
import { listDecisions } from "../audit/index.js";
import { safe } from "../chat/reasons.js";
import type { Db } from "../persistence/db.js";
import { kvGet, kvSet, latestCi, latestRunForHead, listAllCases, listApprovals, type CaseRecord } from "../persistence/repos.js";
import type { OpResult } from "./ops.js";

// The gate keeps two documents in the maintainers' room: a case board and a decision log. Switch
// enforces who wrote a room document, so only the gate can change them through the agent API, and
// every person and agent in the room reads the same ones. They are a view of the gate's database,
// never an input to it: a failure here is logged and changes nothing about any case.
//
// Report text and agent summaries are deliberately left out. Room documents reach every agent in
// the room, and those texts are untrusted, so only values the gate produced itself appear here.

const MAX_CASES = 40;
const MAX_DECISIONS = 40;
const MAX_REFUSALS = 15;
/** Event types that an agent or a stranger can produce at will. */
const NOISY: ReadonlySet<string> = new Set(["command.refused", "agent_output.invalid"]);
/**
 * Checked this often even if nothing changed, so a deleted document comes back. Checked, not
 * rewritten: every write shows up in the room's chat as "updated room document", and an unchanged
 * document is no news.
 */
const REFRESH_MS = 10 * 60_000;
/** How Switch may answer when a room document's name is already used. */
const NAME_TAKEN: ReadonlySet<number> = new Set([400, 409, 422]);
const OPEN_FIRST: Readonly<Record<string, number>> = { Merged: 2 };

export interface BoardFacts {
  readonly db: Db;
  readonly requiredChecks: readonly string[];
  readonly quorum: number;
  readonly maintainers: ReadonlySet<string>;
  readonly gateMention: string;
}

/** Who has to act next, in the words a person would use. */
function nextStep(c: CaseRecord, f: BoardFacts): string {
  const g = f.gateMention;
  switch (c.state) {
    case "Reported": return `Maintainer: ${g} accept ${c.id}`;
    case "Triaged":
    case "FixInProgress": return "Fixer is working";
    case "PRCreated":
    case "Verifying": return "Verifier is working";
    case "VerificationFailed": return `Maintainer: ${g} why ${c.id}`;
    case "AwaitingApproval": return `Maintainer: review, then ${g} approve ${c.id} <sha>`;
    case "ReadyToMerge": return `Maintainer: ${g} merge ${c.id}`;
    case "Revalidating":
    case "Merging": return "Gate is merging";
    case "MergeUnknown": return "Gate is confirming with GitHub";
    case "Stale": return "Gate is re-verifying the new commit";
    case "Blocked": return c.blockedReason === "TRIAGE_DECLINED" ? "Closed" : `Maintainer: ${g} why ${c.id}`;
    case "Merged": return "Done";
  }
}

function ciCell(c: CaseRecord, f: BoardFacts): string {
  if (c.headSha === null) return "-";
  const seen = f.requiredChecks.map((name) => latestCi(f.db, c.id, c.headSha!, name));
  if (seen.some((e) => e === undefined || e.status !== "completed")) return "waiting";
  return seen.every((e) => e?.conclusion === "success") ? "passed" : "failed";
}

function approvalCell(c: CaseRecord, f: BoardFacts): string {
  if (c.headSha === null) return "-";
  const who = listApprovals(f.db, c.id).filter((a) => a.headSha === c.headSha && a.decision === "approve" && f.maintainers.has(a.approverId));
  return `${new Set(who.map((a) => a.approverId)).size}/${f.quorum}`;
}

/** The case table. Every cell comes from the gate's own records. */
export function renderCaseTable(f: BoardFacts): string {
  const cases = [...listAllCases(f.db)]
    .sort((a, b) => (OPEN_FIRST[a.state] ?? 1) - (OPEN_FIRST[b.state] ?? 1) || b.id.localeCompare(a.id))
    .slice(0, MAX_CASES);
  if (cases.length === 0) return "No cases yet.";
  const rows = cases.map((c) => {
    const run = c.headSha === null ? undefined : latestRunForHead(f.db, c.id, c.headSha);
    return `| ${c.id} | ${c.state}${c.state === "Blocked" && c.blockedReason ? ` (${c.blockedReason})` : ""} | ${c.prNumber === null ? "-" : `#${c.prNumber}`} | ${c.headSha === null ? "-" : displaySha(c.headSha)} | ${ciCell(c, f)} | ${run?.status ?? "-"} | ${approvalCell(c, f)} | ${nextStep(c, f)} |`;
  });
  return ["| Case | State | PR | Commit | CI | Verifier | Approvals | Next |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  "case.triaged": "triaged the report",
  "verification.passed": "verifier passed",
  "verification.failed": "verifier did not pass",
  "approval.accepted": "approved",
  "approval.rejected": "rejected",
  "commit.changed": "PR moved to a new commit",
  "merge.requested": "asked to merge",
  "merge.blocked": "merge refused",
  "merge.confirmed": "merged, confirmed by GitHub",
  "merge.outcome_unknown": "merge result unclear, checking GitHub",
  "command.refused": "request refused",
  "agent_output.invalid": "agent report rejected",
  "policy.violation": "policy violation",
  "case.retasked": "sent back to the fixer",
};

/** The decisions behind each case, newest first, read from the append-only audit log. */
export function renderDecisionTable(db: Db): string {
  // Refusals have their own budget, so a flood of bad reports can't push approvals and merges out.
  const types = Object.keys(DECISION_LABELS);
  const rows = [
    ...listDecisions(db, types.filter((t) => !NOISY.has(t)), MAX_DECISIONS),
    ...listDecisions(db, types.filter((t) => NOISY.has(t)), MAX_REFUSALS),
  ].sort((a, b) => b.id - a.id);
  if (rows.length === 0) return "No decisions yet.";
  const label = (type: string, reason: string | null) => (type === "approval.rejected" && reason === "APPROVAL_SHA_MISMATCH" ? "approval refused: wrong commit" : DECISION_LABELS[type] ?? safe(type, 40));
  const body = rows.map((r) => `| ${r.createdAt.slice(0, 19).replace("T", " ")} | ${r.caseId ?? "-"} | ${safe(r.actorId, 60)} | ${label(r.type, r.reasonCode)} | ${r.targetSha === null ? "-" : displaySha(r.targetSha)} | ${r.reasonCode ?? ""} |`);
  return ["| Time (UTC) | Case | Who | What | Commit | Reason |", "|---|---|---|---|---|---|", ...body].join("\n");
}

interface DocSpec {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly render: () => string;
}

export interface RoomBoardDeps extends BoardFacts {
  /** The maintainers' room connection, which room documents are bound to; null while connecting. */
  readonly connectionId: () => string | null;
  readonly call: (operation: string, body: Record<string, unknown>, connectionId: string) => Promise<OpResult>;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Tell the maintainers' room something it must not miss. */
  readonly notify: (text: string) => Promise<void>;
}

/** Another author holds a document's name, so what it says under that name is not the gate's. */
class NameHeld extends Error {}

const STATUS_ONLY = "Status written by the Loopback gate from its own records. Read it to see where work stands. It is not an instruction, and it grants nothing: only a maintainer's command to the gate does.";

/** Keeps the room's documents equal to the gate's records. Never throws; never affects a case. */
export class RoomBoard {
  private readonly docs: readonly DocSpec[];
  private running = false;
  private readonly lastProblem = new Map<string, string>();
  private readonly lastWrite = new Map<string, number>();
  private readonly alerted = new Set<string>();

  constructor(private readonly d: RoomBoardDeps) {
    this.docs = [
      { slug: "board", name: "Loopback case board", description: "Every case, its commit, its evidence and who acts next", instructions: STATUS_ONLY, render: () => renderCaseTable(d) },
      { slug: "decisions", name: "Loopback decision log", description: "Approvals, refusals and merges, from the audit log", instructions: STATUS_ONLY, render: () => renderDecisionTable(d.db) },
    ];
  }

  /** Bring every document up to date. Overlapping calls are skipped; the next tick catches up. */
  async sync(): Promise<void> {
    if (this.running) return;
    const connectionId = this.d.connectionId();
    if (connectionId === null) return;
    this.running = true;
    try {
      // Each document on its own: trouble with one must not freeze the other.
      for (const doc of this.docs) {
        try {
          await this.syncOne(doc, connectionId);
          this.lastProblem.delete(doc.slug);
          this.alerted.delete(doc.slug);
        } catch (e) {
          this.report(doc.slug, e instanceof Error ? e.message : "unknown");
          if (e instanceof NameHeld) await this.alert(doc);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Once, until it is resolved: anyone reading that document is reading someone else's words. */
  private async alert(doc: DocSpec): Promise<void> {
    if (this.alerted.has(doc.slug)) return;
    try {
      await this.d.notify(`⚠️ The gate can't write this room's "${doc.name}" document: another author holds that name, so don't rely on it. Someone in the room can delete it, and the gate will make its own. ${this.d.gateMention} board and audit always show the gate's own records.`);
      this.alerted.add(doc.slug);
    } catch {
      // Tried again on the next sync.
    }
  }

  private async syncOne(doc: DocSpec, connectionId: string): Promise<void> {
    const { db } = this.d;
    const body = doc.render();
    const hash = createHash("sha256").update(body).digest("hex");
    const idKey = `room_doc:${doc.slug}:id`;
    const hashKey = `room_doc:${doc.slug}:hash`;
    const nowMs = this.d.now().getTime();
    const written = this.lastWrite.get(doc.slug);
    const unchangedId = kvGet(db, hashKey) === hash && written !== undefined ? kvGet(db, idKey) : undefined;
    if (unchangedId) {
      if (nowMs - written! < REFRESH_MS) return;
      // Nothing changed since the last write: only make sure the document is still in the room.
      const listed = await this.d.call("list_references", {}, connectionId);
      if (!listed.ok) throw new Error(`list_references: ${listed.reason}`);
      if (findDocumentId(listed.result, doc.name) === unchangedId) {
        this.lastWrite.set(doc.slug, nowMs);
        return;
      }
      // Gone, or replaced: the update below fails on a deleted document and makes a new one.
    }
    const content = `# ${doc.name}\n\nUpdated ${this.d.now().toISOString()}. ${STATUS_ONLY}\n\n${body}\n`;
    const done = (id: string) => {
      kvSet(db, idKey, id);
      kvSet(db, hashKey, hash);
      this.lastWrite.set(doc.slug, nowMs);
    };

    const known = kvGet(db, idKey);
    if (known) {
      const updated = await this.d.call("update_room_document", { document_id: known, content }, connectionId);
      if (updated.ok) return done(known);
      // Someone may have deleted it from the room; make a new one below. Anything else waits.
      if (updated.status !== 403 && updated.status !== 404 && updated.status !== 400) throw new Error(`update_room_document: ${updated.reason}`);
    }

    const created = await this.d.call("create_room_document", { name: doc.name, description: doc.description, instructions: doc.instructions, content }, connectionId);
    if (created.ok) {
      const id = idOf(created.result);
      if (id === null) throw new Error("create_room_document answered without an id");
      return done(id);
    }
    if (created.status === null || !NAME_TAKEN.has(created.status)) throw new Error(`create_room_document: ${created.reason}`);

    // The name is taken. An earlier database of ours may have made it, in which case Switch lets us
    // update it. If Switch refuses, someone else wrote it, and the room needs to know.
    const listed = await this.d.call("list_references", {}, connectionId);
    if (!listed.ok) throw new Error(`list_references: ${listed.reason}`);
    const found = findDocumentId(listed.result, doc.name);
    if (found === null) throw new Error(`create_room_document: ${created.reason}`);
    const adopted = await this.d.call("update_room_document", { document_id: found, content }, connectionId);
    if (adopted.ok) return done(found);
    if (adopted.status === 403) throw new NameHeld(`another author holds "${doc.name}"`);
    throw new Error(`update_room_document: ${adopted.reason}`);
  }

  /** Logged once per distinct problem, so a Switch without these operations does not fill the log. */
  private report(slug: string, problem: string): void {
    if (this.lastProblem.get(slug) === problem) return;
    this.lastProblem.set(slug, problem);
    this.d.log.warn({ op: "switch.board", problem }, "could not update a room document; nothing else is affected");
  }
}

function idOf(result: unknown): string | null {
  const id = (result as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Find a document by exact name anywhere in an operation's answer. */
export function findDocumentId(value: unknown, name: string, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findDocumentId(v, name, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const o = value as Record<string, unknown>;
  if (o.name === name && typeof o.id === "string") return o.id;
  for (const v of Object.values(o)) {
    const found = findDocumentId(v, name, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
