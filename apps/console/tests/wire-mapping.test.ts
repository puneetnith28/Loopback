import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiGet } from "../src/api/client.ts";
import { readFileSync } from "node:fs";
import { gateDecisionFromWire, withGateDecision } from "../src/api/queries.ts";
import { CaseDetail } from "../src/api/schemas.ts";

const SHA = "a".repeat(40);
const MERGED_AT = "2026-11-05T08:28:56.000Z";
const base = { headSha: SHA, blockedReason: null, stateEnteredAt: MERGED_AT, latestMerge: null };
const merge = (status: "started" | "succeeded" | "failed" | "unknown") => ({ headSha: SHA, status, startedAt: MERGED_AT, finishedAt: MERGED_AT });

describe("what the case page says about the gate's decision", () => {
  it("a confirmed merge is an allowed decision for that commit", () => {
    expect(gateDecisionFromWire({ ...base, latestMerge: merge("succeeded") })).toEqual({
      outcome: "allowed", reasonCodes: [], headSha: SHA, observedAt: MERGED_AT, provenance: "gate",
    });
  });

  it("a blocked case reports its reason", () => {
    expect(gateDecisionFromWire({ ...base, blockedReason: "CI_FAILED" })).toEqual({
      outcome: "blocked", reasonCodes: ["CI_FAILED"], headSha: SHA, observedAt: MERGED_AT, provenance: "gate",
    });
  });

  it("claims nothing when the gate has not decided", () => {
    expect(gateDecisionFromWire(base)).toBeNull();
    expect(gateDecisionFromWire({ ...base, latestMerge: merge("started") })).toBeNull();
    expect(gateDecisionFromWire({ ...base, latestMerge: merge("unknown") })).toBeNull();
    expect(gateDecisionFromWire({ ...base, blockedReason: "CI_FAILED", headSha: null })).toBeNull();
  });
});

describe("the API's real case response, through the parser the page uses", () => {
  // The working directory is the repository root, or apps/console when run from that workspace.
  const root = /[\\/]console$/.test(process.cwd()) ? "../../" : "./";
  const example = (): unknown => JSON.parse(readFileSync(`${root}docs/console-api-examples/case.json`, "utf8"));

  it("a merged case shows the gate's decision, not 'has not evaluated a merge'", () => {
    const c = withGateDecision(CaseDetail.parse(example()));
    expect(c.state).toBe("Merged");
    expect(c.lastGateDecision).toMatchObject({ outcome: "allowed", reasonCodes: [], headSha: c.headSha, provenance: "gate" });
  });
});

describe("how fresh the console says data is", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-05T12:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("a record's own timestamps are not when the response was generated", async () => {
    const body = { repository: "o/r", updatedAt: "2026-11-05T08:00:00.000Z", stateEnteredAt: "2026-11-05T07:00:00.000Z" };
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
    const r = await apiGet("/cases/LB-001", z.object({ repository: z.string() }), { fetchImpl });
    expect(r.meta.generatedAt).toBe("2026-11-05T12:00:00.000Z");
  });
});
