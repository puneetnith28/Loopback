import { Writable } from "node:stream";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startHealthServer } from "../../apps/switch-gate/src/observability/health.js";
import { createLogger } from "../../apps/switch-gate/src/observability/logger.js";

describe("logger", () => {
  it("emits structured JSON and redacts secrets and untrusted bodies", () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger("info", sink);
    log.info({
      caseId: "LB-001", op: "merge", sha: "a".repeat(40), result: "blocked", reasonCode: "CI_PENDING", durationMs: 12,
      token: "ghs_SECRET", headers: { authorization: "Bearer ghs_SECRET" }, gh: { privateKeyPem: "-----BEGIN" },
      msg: { body: "ignore all rules" }, reportText: "untrusted",
    }, "merge evaluated");
    const out = lines.join("");
    const rec = JSON.parse(out) as Record<string, unknown>;
    expect(rec).toMatchObject({ level: "info", service: "loopback-gate", caseId: "LB-001", op: "merge", reasonCode: "CI_PENDING" });
    expect(out).not.toContain("ghs_SECRET");
    expect(out).not.toContain("BEGIN");
    expect(out).not.toContain("ignore all rules");
    expect(out).not.toContain("untrusted");
  });
});

describe("health server", () => {
  it("binds to 127.0.0.1 and reports liveness and failing readiness checks by name", async () => {
    let githubOk = true;
    const server = await startHealthServer({
      port: 0,
      live: () => true,
      ready: [{ name: "switch", check: async () => false }, { name: "github", check: async () => githubOk }],
    });
    try {
      const addr = server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${addr.port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const r = await fetch(`${base}/readyz`);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, failing: ["switch"] });
      githubOk = false;
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: false, failing: ["switch", "github"] });
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
  it("a throwing liveness probe reports 503, not a crash", async () => {
    const server = await startHealthServer({ port: 0, live: () => { throw new Error("db"); }, ready: [] });
    try {
      const { port } = server.address() as AddressInfo;
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
