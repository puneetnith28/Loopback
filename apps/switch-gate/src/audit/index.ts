import type { AuditEventType, ReasonCode } from "@loopback/contracts";
import type { Db } from "../persistence/db.js";

// The audit log is append-only: this module exposes append() and read helpers,
// never update or delete, and SQLite triggers reject UPDATE/DELETE as well.

export interface AuditEntry {
  readonly caseId: string | null;
  readonly actorId: string;
  readonly type: AuditEventType;
  readonly targetSha?: string | null;
  readonly reasonCode?: ReasonCode | null;
  readonly payload?: Record<string, unknown>;
}

export interface AuditRow {
  readonly id: number;
  readonly caseId: string | null;
  readonly actorId: string;
  readonly type: string;
  readonly targetSha: string | null;
  readonly reasonCode: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

const SECRET_KEY = /token|key|secret|password|authorization|credential|cookie/i;
export const UNTRUSTED_TEXT_LIMIT = 200;

/** Remove secret-looking keys (recursively) and clip long strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") {
    return value.length > UNTRUSTED_TEXT_LIMIT ? `${value.slice(0, UNTRUSTED_TEXT_LIMIT)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function append(db: Db, entry: AuditEntry, now: Date = new Date()): number {
  const payload = JSON.stringify(redact(entry.payload ?? {}));
  const info = db
    .prepare(
      `INSERT INTO audit_events (case_id, actor_id, event_type, target_sha, reason_code, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.caseId, entry.actorId, entry.type, entry.targetSha ?? null, entry.reasonCode ?? null, payload, now.toISOString());
  return Number(info.lastInsertRowid);
}

interface RawRow {
  id: number;
  case_id: string | null;
  actor_id: string;
  event_type: string;
  target_sha: string | null;
  reason_code: string | null;
  payload_json: string;
  created_at: string;
}

const toRow = (r: RawRow): AuditRow => ({
  id: r.id,
  caseId: r.case_id,
  actorId: r.actor_id,
  type: r.event_type,
  targetSha: r.target_sha,
  reasonCode: r.reason_code,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  createdAt: r.created_at,
});

/** Newest-first events for a case (for the `audit` command). */
export function listRecent(db: Db, caseId: string, limit = 15): AuditRow[] {
  const rows = db
    .prepare("SELECT * FROM audit_events WHERE case_id = ? ORDER BY id DESC LIMIT ?")
    .all(caseId, limit) as RawRow[];
  return rows.map(toRow);
}

export function countEvents(db: Db, caseId: string, type: AuditEventType, targetSha?: string): number {
  const row = (targetSha === undefined
    ? db.prepare("SELECT count(*) AS n FROM audit_events WHERE case_id = ? AND event_type = ?").get(caseId, type)
    : db.prepare("SELECT count(*) AS n FROM audit_events WHERE case_id = ? AND event_type = ? AND target_sha = ?").get(caseId, type, targetSha)) as { n: number };
  return row.n;
}
