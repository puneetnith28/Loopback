import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { passed, renderEvidence, runProof, validateInputs, type Api, type ApiResult } from "../../scripts/ruleset-proof.mjs";
import { smoke } from "../../scripts/smoke.mjs";

// The proof's own logic against a stand-in GitHub. It must never report a pass it did not observe,
// always clean up, and refuse to run without what makes its evidence meaningful. Running it against
// real GitHub is the owner's step: this says nothing about the real rulesets.

const REPO = "o/demo";
const RUN = "demo/20261105-0123456789abcdef";
const SHA = "1".repeat(40);
const HEAD = "2".repeat(40);
const NONCE = "abc123";

type Handler = (actor: string, method: string, path: string, body: unknown) => ApiResult | undefined;

/** A correctly configured repository: every write the rules forbid is refused. */
function github(over: Handler = () => undefined): { api: Api; calls: string[] } {
  const calls: string[] = [];
  const api: Api = (actor, method, path, body) => {
    calls.push(`${actor} ${method} ${path}`);
    const custom = over(actor, method, path, body);
    if (custom) return Promise.resolve(custom);
    const p = path.replace(`repos/${REPO}/`, "");
    const reply = (status: number, b: unknown = {}) => Promise.resolve({ status, body: b });
    if (method === "GET" && p === `git/ref/heads/${RUN}`) return reply(200, { object: { sha: SHA } });
    if (method === "GET" && p === "git/ref/tags/demo-reset") return reply(200, { object: { sha: "9".repeat(40) } });
    if (method === "GET" && p.startsWith(`commits/${HEAD}/check-runs`)) return reply(200, { check_runs: [{ status: "completed", conclusion: "success" }] });
    if (method === "GET" && p === "rulesets") return reply(200, [{ target: "branch", enforcement: "active" }, { target: "tag", enforcement: "active" }]);
    if (method === "POST" && p === "git/refs") return reply(201);
    if (method === "PUT" && p === `contents/proof/${NONCE}.txt`) return reply(201, { commit: { sha: HEAD } });
    if (method === "POST" && p === "pulls") return reply(201, { number: 7 });
    if (method === "PUT" && p === "pulls/7/merge") return reply(405);
    if (method === "POST" && p === `statuses/${HEAD}`) return reply(actor === "owner" ? 201 : 403);
    if (method === "PUT" && p.startsWith("contents/")) return reply(403);
    if (method === "PATCH" && p === "git/refs/tags/demo-reset") return reply(422);
    if (method === "PATCH" && p === "pulls/7") return reply(200);
    if (method === "DELETE") return reply(204);
    return reply(500);
  };
  return { api, calls };
}
const run = (g: { api: Api }, extra: Partial<Parameters<typeof runProof>[1]> = {}) => runProof(g.api, { repo: REPO, runBranch: RUN, resetSha: SHA, nonce: NONCE, wait: () => Promise.resolve(), ...extra });
const verdict = (o: { id: string; verdict: string }[], id: string) => o.find((x) => x.id === id)?.verdict;

describe("runProof", () => {
  it("passes a correct setup, covering the nine outcomes it can observe", async () => {
    const r = await run(github());
    expect(passed(r.outcomes), JSON.stringify(r.outcomes)).toBe(true);
    expect(r.outcomes.map((o) => o.id)).toEqual(expect.arrayContaining(["1", "2", "3", "3b", "4", "4b", "5", "6", "9a", "9b"]));
    expect(r.pr).toBe(7);
  });

  it("always closes the PR and deletes its branch", async () => {
    const g = github();
    await run(g);
    expect(g.calls).toContain(`owner PATCH repos/${REPO}/pulls/7`);
    expect(g.calls).toContain(`owner DELETE repos/${REPO}/git/refs/heads/loopback/proof-${NONCE}`);
  });

  it.each([
    ["1", "the maintainer can merge", (a: string, m: string, p: string) => (a === "owner" && m === "PUT" && p.endsWith("/merge") ? { status: 200 } : undefined)],
    ["2", "the fixer can merge", (a: string, m: string, p: string) => (a === "fixer" && m === "PUT" && p.endsWith("/merge") ? { status: 200 } : undefined)],
    ["3", "the fixer can post the gate status", (a: string, m: string, p: string) => (a === "fixer" && m === "POST" && p.includes("/statuses/") ? { status: 201 } : undefined)],
    ["4", "the fixer can push to the run branch", (a: string, m: string, p: string) => (a === "fixer" && m === "PUT" && p.includes("/contents/proof/direct-") ? { status: 201 } : undefined)],
    ["4b", "the fixer can change a workflow", (a: string, m: string, p: string) => (a === "fixer" && m === "PUT" && p.includes("/workflows/") ? { status: 201 } : undefined)],
  ])("outcome %s fails when %s", async (id, _name, handler) => {
    const r = await run(github(handler));
    expect(verdict(r.outcomes, id)).toBe("FAIL");
    expect(passed(r.outcomes)).toBe(false);
  });

  it("a status from the wrong source that unlocks a merge fails 3b, the outcome that proves the App pin", async () => {
    let forged = false;
    const r = await run(github((a, m, p) => {
      if (a === "owner" && m === "POST" && p.includes("/statuses/")) { forged = true; return { status: 201 }; }
      if (a === "owner" && m === "PUT" && p.endsWith("/merge") && forged) return { status: 200 };
      return undefined;
    }));
    expect(verdict(r.outcomes, "1")).toBe("PASS");
    expect(verdict(r.outcomes, "3b")).toBe("FAIL");
  });

  it("an unexpected error status is not a refusal", async () => {
    const r = await run(github((a, m, p) => (a === "fixer" && m === "PUT" && p.endsWith("/merge") ? { status: 502 } : undefined)));
    expect(verdict(r.outcomes, "2")).toBe("FAIL");
  });

  it("never attempts to move the tag without a tag ruleset: that request would succeed", async () => {
    const g = github((_a, m, p) => (m === "GET" && p.endsWith("/rulesets") ? { status: 200, body: [{ target: "branch", enforcement: "active" }] } : undefined));
    const r = await run(g);
    expect(verdict(r.outcomes, "9b")).toBe("NOT RUN");
    expect(g.calls.some((c) => c.includes("PATCH") && c.includes("tags/demo-reset"))).toBe(false);
    expect(passed(r.outcomes)).toBe(false);
  });

  it("if the tag moves anyway, it fails and puts the tag back at once", async () => {
    const bodies: unknown[] = [];
    const r = await run(github((_a, m, p, body) => {
      if (m === "PATCH" && p.endsWith("tags/demo-reset")) { bodies.push(body); return { status: 200 }; }
      return undefined;
    }));
    expect(verdict(r.outcomes, "9b")).toBe("FAIL");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ sha: "9".repeat(40), force: true });
    expect(verdict(r.outcomes, "9c")).toBe("PASS");
  });

  it("stops at once when the run branch is missing, having created nothing", async () => {
    const g = github((_a, m, p) => (m === "GET" && p.endsWith(RUN) ? { status: 404 } : undefined));
    const r = await run(g);
    expect(verdict(r.outcomes, "5")).toBe("FAIL");
    expect(g.calls.some((c) => !c.includes(" GET "))).toBe(false);
  });

  it("reports a run branch that has moved", async () => {
    const r = await run(github((_a, m, p) => (m === "GET" && p.endsWith(RUN) ? { status: 200, body: { object: { sha: "3".repeat(40) } } } : undefined)));
    expect(verdict(r.outcomes, "9a")).toBe("FAIL");
  });

  it("without green CI, outcome 1 is not run rather than passed: a refusal would prove nothing", async () => {
    let t = 0;
    const r = await run(github((_a, m, p) => (m === "GET" && p.includes("/check-runs") ? { status: 200, body: { check_runs: [{ status: "in_progress" }] } } : undefined)), { now: () => (t += 60_000), ciWaitMs: 120_000 });
    expect(verdict(r.outcomes, "1")).toBe("NOT RUN");
    expect(verdict(r.outcomes, "3b")).toBe("NOT RUN");
    expect(passed(r.outcomes)).toBe(false);
  });

  it("still cleans up, and reports it, when a step throws or a cleanup fails", async () => {
    const g = github((_a, m, p) => {
      if (m === "DELETE") return { status: 500 };
      if (m === "GET" && p.endsWith("/rulesets")) throw new Error("network");
      return undefined;
    });
    await expect(run(g)).rejects.toThrow("network");
    expect(g.calls.some((c) => c.includes("PATCH") && c.endsWith("pulls/7"))).toBe(true);
    expect(g.calls.some((c) => c.includes("DELETE"))).toBe(true);
  });
});

describe("evidence and inputs", () => {
  it("an empty result is not a pass", () => {
    expect(passed([])).toBe(false);
  });

  it("renders every outcome and the overall verdict", () => {
    const text = renderEvidence({ repo: REPO, runBranch: RUN, resetSha: SHA, when: "2026-11-05", pr: 7, outcomes: [{ id: "1", title: "a|b", expected: "x", actual: "405", verdict: "PASS" }, { id: "2", title: "t", expected: "x", actual: "200", verdict: "FAIL" }] });
    expect(text).toContain("a\\|b");
    expect(text).toContain("throwaway PR #7");
    expect(text).toContain("NOT PROVEN");
  });

  it.each([
    [{ repo: "bad", runBranch: RUN, resetSha: SHA }, /owner\/repo/],
    [{ repo: "puneetnith28/Loopback", runBranch: RUN, resetSha: SHA }, /main Loopback/],
    [{ repo: REPO, runBranch: "main", resetSha: SHA }, /RUN_BRANCH/],
    [{ repo: REPO, runBranch: "demo/x", resetSha: SHA }, /RUN_BRANCH/],
    [{ repo: REPO, runBranch: RUN, resetSha: "abc" }, /DEMO_RESET_SHA/],
    [{}, /GH_REPO/],
  ])("refuses %j", (input, message) => {
    expect(validateInputs(input).join("\n")).toMatch(message);
  });

  it("accepts good inputs", () => {
    expect(validateInputs({ repo: REPO, runBranch: RUN, resetSha: SHA })).toEqual([]);
  });

  it("the dry run sends nothing, needs no token, and shows the requests", () => {
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "ruleset-proof.mjs")], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", GH_REPO: REPO, RUN_BRANCH: RUN, DEMO_RESET_SHA: SHA },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN: nothing was sent");
    expect(r.stdout).toMatch(/fixer PUT\s+repos\/o\/demo\/pulls\/\d+\/merge/);
    expect(r.stdout).toMatch(/owner PATCH\s+repos\/o\/demo\/git\/refs\/tags\/demo-reset/);
  });

  it("without inputs, it refuses with exit 2", () => {
    const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "ruleset-proof.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } });
    expect(r.status).toBe(2);
  });
});

describe("smoke", () => {
  const serve = async (health: number, ready: number, failing: string[] = []) => {
    const srv = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? health : ready, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/healthz" ? { ok: health === 200 } : { ok: ready === 200, failing }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const a = srv.address();
    return { srv, port: typeof a === "object" && a !== null ? a.port : 0 };
  };

  it("is ready only when live and ready both answer 200", async () => {
    const s = await serve(200, 200);
    expect((await smoke(s.port)).code).toBe(0);
    s.srv.close();
  });

  it("names failing checks and exits 1", async () => {
    const s = await serve(200, 503, ["heartbeat:intake", "not-halted"]);
    const r = await smoke(s.port);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toContain("heartbeat:intake, not-halted");
    s.srv.close();
  });

  it("exits 2 when no gate answers", async () => {
    const r = await smoke(1);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/no gate answering/);
  });
});
