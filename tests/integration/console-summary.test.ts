import { describe, expect, it } from "vitest";
import { SummaryResponse } from "@loopback/console-contracts";
import { summary } from "../../apps/console-api/src/store.js";
import { migrate, openDatabase } from "../../apps/switch-gate/src/persistence/db.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const SHA = "a".repeat(40);

function database(runs: readonly { status: string; daysAgo: number }[]) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  const insert = db.prepare("INSERT INTO verification_runs (id, case_id, repo, pr_number, head_sha, status, requested_at) VALUES (?, 'LB-001', 'o/r', 1, ?, ?, ?)");
  runs.forEach((r, i) => insert.run(`run-${i}`, SHA, r.status, new Date(NOW.getTime() - r.daysAgo * 86_400_000).toISOString()));
  return db;
}

describe("the console's verification counts come from the runs themselves", () => {
  it("counts each run once by its status: the LB-001 history is 1 pass and 3 timeouts, not 3 failures and 4 running", () => {
    const db = database([{ status: "timeout", daysAgo: 1 }, { status: "timeout", daysAgo: 1 }, { status: "timeout", daysAgo: 0 }, { status: "pass", daysAgo: 0 }]);
    const s = SummaryResponse.parse(summary(db, NOW));
    expect(s.verification).toEqual({ windowDays: 7, pass: 1, fail: 0, invalid: 0, timeout: 3, requested: 0, superseded: 0 });
    db.close();
  });

  it("counts every status, and leaves out runs older than the window", () => {
    const db = database([
      { status: "requested", daysAgo: 0 }, { status: "fail", daysAgo: 1 }, { status: "invalid", daysAgo: 2 },
      { status: "superseded", daysAgo: 3 }, { status: "pass", daysAgo: 6 }, { status: "pass", daysAgo: 8 },
    ]);
    expect(summary(db, NOW).verification).toEqual({ windowDays: 7, pass: 1, fail: 1, invalid: 1, timeout: 0, requested: 1, superseded: 1 });
    db.close();
  });
});
