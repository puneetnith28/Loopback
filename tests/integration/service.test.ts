import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecent } from "../../apps/switch-gate/src/audit/index.js";
import { IllegalTransition } from "../../apps/switch-gate/src/cases/machine.js";
import { ConcurrentModification, createCase, formatCaseId, transition } from "../../apps/switch-gate/src/cases/service.js";
import { migrate, openDatabase, type Db } from "../../apps/switch-gate/src/persistence/db.js";
import { getCase } from "../../apps/switch-gate/src/persistence/repos.js";

let db: Db;
const NOW = new Date("2026-11-04T10:00:00Z");
const input = (eventId: string) => ({ reporterId: "@r:x", roomId: "room", threadId: null, repo: "o/r", reportText: "slugify crashes on null", sourceEventId: eventId });

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("case numbering", () => {
  it("allocates LB-001, LB-002 … in order", () => {
    expect(createCase(db, input("e1"), NOW)!.id).toBe("LB-001");
    expect(createCase(db, input("e2"), NOW)!.id).toBe("LB-002");
    expect(formatCaseId(1234)).toBe("LB-1234");
  });
  it("a redelivered report event creates no second case", () => {
    expect(createCase(db, input("e1"), NOW)).toBeDefined();
    expect(createCase(db, input("e1"), NOW)).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 1 });
  });
  it("a failed creation consumes no number (no gaps on rollback)", () => {
    db.exec("CREATE TRIGGER fail_once BEFORE INSERT ON cases WHEN NEW.report_text = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    expect(() => createCase(db, { ...input("e1"), reportText: "boom" }, NOW)).toThrow(/boom/);
    expect(createCase(db, input("e2"), NOW)!.id).toBe("LB-001");
  });
  it("records the case with its branch and a creation audit event", () => {
    const c = createCase(db, input("e1"), NOW)!;
    expect(c).toMatchObject({ state: "Reported", branch: "loopback/LB-001", version: 0 });
    expect(listRecent(db, c.id).map((r) => r.type)).toEqual(["case.created"]);
  });
});

describe("transition", () => {
  it("updates state, bumps version and appends an audit event atomically", () => {
    const c = createCase(db, input("e1"), NOW)!;
    const t = transition(db, { caseId: c.id, to: "Triaged", actorId: "system", trigger: "system", reason: null }, NOW);
    expect(t).toMatchObject({ state: "Triaged", version: 1 });
    const audit = listRecent(db, c.id);
    expect(audit[0]).toMatchObject({ type: "case.state_changed", payload: { from: "Reported", to: "Triaged", trigger: "system" } });
  });
  it("rejects illegal transitions without changing anything", () => {
    const c = createCase(db, input("e1"), NOW)!;
    expect(() => transition(db, { caseId: c.id, to: "Merged", actorId: "x", trigger: "reconcile", reason: null }, NOW)).toThrow(IllegalTransition);
    expect(getCase(db, c.id)!.state).toBe("Reported");
    expect(listRecent(db, c.id)).toHaveLength(1);
  });
  it("rejects a stale expected version (optimistic lock)", () => {
    const c = createCase(db, input("e1"), NOW)!;
    transition(db, { caseId: c.id, to: "Triaged", actorId: "s", trigger: "system", reason: null }, NOW);
    expect(() => transition(db, { caseId: c.id, to: "FixInProgress", actorId: "s", trigger: "system", reason: null, expectedVersion: 0 }, NOW))
      .toThrow(ConcurrentModification);
  });
  it("if the audit append fails, the state change is rolled back", () => {
    const c = createCase(db, input("e1"), NOW)!;
    db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON audit_events WHEN NEW.event_type = 'case.state_changed' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    expect(() => transition(db, { caseId: c.id, to: "Triaged", actorId: "s", trigger: "system", reason: null }, NOW)).toThrow(/disk full/);
    expect(getCase(db, c.id)).toMatchObject({ state: "Reported", version: 0 });
  });
  it("records the Blocked reason and clears it when leaving Blocked", () => {
    const c = createCase(db, input("e1"), NOW)!;
    const b = transition(db, { caseId: c.id, to: "Blocked", actorId: "s", trigger: "system", reason: "BASE_COMMIT_MISMATCH" }, NOW);
    expect(b.blockedReason).toBe("BASE_COMMIT_MISMATCH");
    const f = transition(db, { caseId: c.id, to: "FixInProgress", actorId: "m", trigger: "command", reason: null }, NOW);
    expect(f.blockedReason).toBeNull();
  });
});
