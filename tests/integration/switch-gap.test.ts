/* eslint-disable @typescript-eslint/require-await -- test fakes implement async interfaces without awaiting anything */
import { describe, expect, it, vi } from "vitest";
import { recoverGap, type GapDeps } from "../../apps/switch-gate/src/switch/gap.js";
import type { ContextEntry, ContextRead } from "../../apps/switch-gate/src/switch/ops.js";

// Step 3.9: after a delivery gap, nothing recovered is executed (read_context carries no
// `addressed` flag). Recovery records what was missed, tells maintainers how many to
// resend without echoing content, and always reconciles cases against GitHub.

const SELF = "@switch-agent-gate:localhost";
const FIXER = "@switch-agent-fixer:localhost";
const PERSON = "@alice:localhost";
const G = "@loopback-gate";

const e = (id: string, sender: string, body: string): ContextEntry => ({ id, kind: "message", sender, body, timestamp: 1 });

function deps(read: ContextRead, processed: readonly string[] = []) {
  const records: { roomId: string; payload: Readonly<Record<string, unknown>> }[] = [];
  const notices: string[] = [];
  const d: GapDeps = {
    readContext: vi.fn(async () => read),
    isProcessed: (id) => processed.includes(id),
    gateMention: G,
    agentIds: new Set([FIXER]),
    selfId: SELF,
    record: (roomId, payload) => { records.push({ roomId, payload }); },
    notifyMaintainers: vi.fn(async (t: string) => { notices.push(t); }),
    reconcile: vi.fn(async () => undefined),
    log: { error: vi.fn() },
  };
  return { d, records, notices };
}

describe("recoverGap", () => {
  it("counts only unprocessed messages aimed at the gate, records them, and never echoes their content", async () => {
    const t = deps({ ok: true, truncated: false, entries: [
      e("m1", PERSON, `${G} approve LB-001 abc`), // missed command
      e("m2", PERSON, "just chatter"), // not aimed at the gate
      e("m3", FIXER, "report without mention"), // agent: always aimed
      e("m4", SELF, `${G} our own echo`), // the gate itself
      e("m5", PERSON, `${G} help`), // already processed
    ] }, ["m5"]);
    const r = await recoverGap("room-1", "buffer_overflow", t.d);
    expect(r).toEqual({ read: true, missed: 2, truncated: false });
    expect(t.records).toEqual([{ roomId: "room-1", payload: {
      reason: "buffer_overflow", recovered: true, truncated: false,
      missed: [{ messageId: "m1", sender: PERSON, timestamp: 1 }, { messageId: "m3", sender: FIXER, timestamp: 1 }],
    } }]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatch(/2 message\(s\) addressed to the gate were not processed/);
    expect(t.notices[0]).toMatch(/not executed/);
    expect(t.notices[0]).not.toMatch(/approve|LB-001|report without/);
    expect(t.d.reconcile).toHaveBeenCalledTimes(1);
  });

  it("stays quiet in chat when nothing was missed, but still records and reconciles", async () => {
    const t = deps({ ok: true, truncated: false, entries: [e("m1", PERSON, "chatter")] });
    expect(await recoverGap("room-1", "r", t.d)).toEqual({ read: true, missed: 0, truncated: false });
    expect(t.notices).toEqual([]);
    expect(t.records).toHaveLength(1);
    expect(t.d.reconcile).toHaveBeenCalledTimes(1);
  });

  it("warns that there may be more when the history was truncated", async () => {
    const t = deps({ ok: true, truncated: true, entries: [] });
    await recoverGap("room-1", "r", t.d);
    expect(t.notices[0]).toMatch(/history truncated; there may be more/);
  });

  it("when the history cannot be read, records the failure and asks maintainers to resend", async () => {
    const t = deps({ ok: false, reason: "read_context failed (HTTP 503)" });
    expect(await recoverGap("room-1", "r", t.d)).toEqual({ read: false, missed: 0, truncated: false });
    expect(t.records).toEqual([{ roomId: "room-1", payload: { reason: "r", recovered: false, error: "read_context failed (HTTP 503)" } }]);
    expect(t.notices[0]).toMatch(/could not be read/);
    expect(t.d.reconcile).toHaveBeenCalledTimes(1);
  });

  it("logs a failed reconciliation instead of throwing", async () => {
    const t = deps({ ok: true, truncated: false, entries: [] });
    const error = vi.fn();
    t.d = { ...t.d, reconcile: vi.fn(async () => { throw new Error("github down"); }), log: { error } };
    await expect(recoverGap("room-1", "r", t.d)).resolves.toMatchObject({ read: true });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ op: "gap.reconcile", err: "Error" }), expect.any(String));
  });
});
