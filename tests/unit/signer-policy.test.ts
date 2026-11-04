import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueCapability, type RunContext } from "../../apps/switch-gate/src/agents/capability.js";
import { signedBytes, verifyReportSignature } from "../../apps/switch-gate/src/agents/signature.js";
import {
  evaluateSignRequest, reportDigest, type LivePull, type SignerPolicyDeps,
} from "../../apps/switch-gate/src/signer/policy.js";

// D29: the signer signs only a schema-valid, unsigned verifier report whose digest matches,
// that is bound to a gate-issued, unexpired capability for the same run, whose PR is open at
// that exact head on GitHub right now, and only once per run.

const issuer = generateKeyPairSync("ed25519");
const signing = generateKeyPairSync("ed25519");
const T0 = new Date("2026-11-04T12:00:00.000Z");
const SHA = "a".repeat(40);
const ctx: RunContext = { runId: "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c", caseId: "LB-001", repository: "o/r", pullRequest: 42, headSha: SHA };

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "verifier", ...ctx, verdict: "pass", regressionTestFailsBeforeFix: true, findings: [], summary: "checked", ...over,
});
const request = (over: { report?: Record<string, unknown>; capability?: string; reportDigest?: string } = {}) => {
  const r = over.report ?? report();
  return { capability: over.capability ?? issueCapability(ctx, issuer.privateKey, T0, 30 * 60_000), report: r, reportDigest: over.reportDigest ?? reportDigest(r), ...over };
};

function deps(over: Partial<SignerPolicyDeps> & { pull?: LivePull | Error } = {}) {
  const claimed = new Map<string, string>();
  const calls = { livePull: 0 };
  const d: SignerPolicyDeps = {
    issuerPublicKey: issuer.publicKey, signingKey: signing.privateKey, allowedRepository: "o/r",
    now: () => new Date(T0.getTime() + 1000),
    livePull: () => {
      calls.livePull += 1;
      const p = over.pull ?? { state: "open", headSha: SHA };
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
    },
    replay: {
      claim: (runId, digest) => (claimed.has(runId) ? false : (claimed.set(runId, digest), true)),
      lookup: (runId) => claimed.get(runId) ?? null,
    },
    ...over,
  };
  return { d, claimed, calls };
}

describe("evaluateSignRequest: the happy path", () => {
  it("signs a valid request; the signature verifies with the signer's public key over the exact report", async () => {
    const { d, claimed } = deps();
    const req = request();
    const r = await evaluateSignRequest(req, d);
    expect(r).toMatchObject({ ok: true, runId: ctx.runId, reportDigest: req.reportDigest });
    if (!r.ok) throw new Error("unreachable");
    expect(verifyReportSignature({ ...req.report, signature: r.signature }, signing.publicKey)).toEqual({ ok: true });
    expect(claimed.get(ctx.runId)).toBe(req.reportDigest);
  });

  it("the digest is SHA-256 over the canonical signed bytes", () => {
    expect(reportDigest(report())).toBe(`sha256:${createHash("sha256").update(signedBytes(report())).digest("hex")}`);
  });
});

describe("evaluateSignRequest: rejections (fail closed, nothing signed, run not consumed)", () => {
  const otherIssuer = generateKeyPairSync("ed25519");
  const cases: [string, () => unknown, Partial<SignerPolicyDeps> & { pull?: LivePull | Error }, string, number][] = [
    ["a non-object body", () => "sign this", {}, "MALFORMED", 400],
    ["an extra top-level field", () => ({ ...request(), approve: true }), {}, "MALFORMED", 400],
    ["a missing capability", () => ({ report: request().report, reportDigest: request().reportDigest }), {}, "MALFORMED", 400],
    ["a digest of the wrong form", () => request({ reportDigest: "md5:abc" }), {}, "MALFORMED", 400],
    ["a report failing the verifier schema", () => request({ report: report({ verdict: "maybe" }) }), {}, "REPORT_INVALID", 400],
    ["a report with an unknown field", () => request({ report: report({ approved: true }) }), {}, "REPORT_INVALID", 400],
    ["a report that already carries a signature", () => request({ report: report({ signature: "x".repeat(86) + "==" }) }), {}, "REPORT_INVALID", 400],
    ["a digest of a different report", () => request({ reportDigest: reportDigest(report({ verdict: "fail" })) }), {}, "DIGEST_MISMATCH", 400],
    ["a capability from another issuer", () => request({ capability: issueCapability(ctx, otherIssuer.privateKey, T0, 60_000) }), {}, "CAPABILITY_INVALID", 403],
    ["a garbage capability", () => request({ capability: "lbcap1.x.y" }), {}, "CAPABILITY_INVALID", 403],
    ["an expired capability", () => request(), { now: () => new Date(T0.getTime() + 31 * 60_000) }, "CAPABILITY_EXPIRED", 403],
    ["a report for another run than the capability", () => request({ report: report({ runId: "00000000-0000-4000-8000-000000000000" }) }), {}, "CONTEXT_MISMATCH", 403],
    ["a report for another head SHA", () => request({ report: report({ headSha: "b".repeat(40) }) }), {}, "CONTEXT_MISMATCH", 403],
    ["a report for another PR", () => request({ report: report({ pullRequest: 7 }) }), {}, "CONTEXT_MISMATCH", 403],
    ["a report for another case", () => request({ report: report({ caseId: "LB-002" }) }), {}, "CONTEXT_MISMATCH", 403],
    ["a run for a repository this signer does not serve", () => request(), { allowedRepository: "other/repo" }, "REPOSITORY_NOT_ALLOWED", 403],
    ["a PR whose head moved", () => request(), { pull: { state: "open", headSha: "c".repeat(40) } }, "STALE_HEAD", 409],
    ["a closed PR", () => request(), { pull: { state: "closed", headSha: SHA } }, "PR_NOT_OPEN", 409],
    ["GitHub unavailable", () => request(), { pull: new Error("ECONNRESET") }, "CONTEXT_UNAVAILABLE", 503],
  ];
  it.each(cases)("rejects %s", async (_n, body, over, code, status) => {
    const { d, claimed } = deps(over);
    expect(await evaluateSignRequest(body(), d)).toEqual({ ok: false, code, status });
    expect(claimed.size).toBe(0);
  });

  it("does not consult GitHub before the request, capability and binding are valid", async () => {
    const { d, calls } = deps();
    await evaluateSignRequest(request({ report: report({ runId: "00000000-0000-4000-8000-000000000000" }) }), d);
    await evaluateSignRequest(request({ capability: "lbcap1.x.y" }), d);
    expect(calls.livePull).toBe(0);
  });

  it("signs one report per run: a retry of the same report gets the same signature (no GitHub call); any other report is refused", async () => {
    const { d, calls } = deps();
    const first = await evaluateSignRequest(request(), d);
    expect(first.ok).toBe(true);
    const before = calls.livePull;
    const retry = await evaluateSignRequest(request(), d);
    expect(retry).toEqual(first); // Ed25519 is deterministic: an idempotent retry, not a second signature
    expect(calls.livePull).toBe(before);
    const forged = report({ verdict: "fail", summary: "second opinion" });
    expect(await evaluateSignRequest(request({ report: forged }), d)).toEqual({ ok: false, code: "REPLAYED", status: 409 });
    expect(calls.livePull).toBe(before); // a conflicting replay is refused before GitHub is consulted
  });

  it("a request that loses the claim race to a different report is refused", async () => {
    const { d } = deps();
    const racing: SignerPolicyDeps = { ...d, replay: { claim: () => false, lookup: (() => { let n = 0; return () => (n++ === 0 ? null : "sha256:" + "0".repeat(64)); })() } };
    expect(await evaluateSignRequest(request(), racing)).toEqual({ ok: false, code: "REPLAYED", status: 409 });
  });

  it.each([
    ["a pass whose regression test did not fail before the fix", { verdict: "pass", regressionTestFailsBeforeFix: false }],
    ["a pass with a high-severity finding", { verdict: "pass", findings: [{ severity: "high", message: "sql injection" }] }],
  ])("refuses an internally inconsistent report: %s", async (_n, over) => {
    const { d, claimed } = deps();
    expect(await evaluateSignRequest(request({ report: report(over) }), d)).toEqual({ ok: false, code: "REPORT_INCONSISTENT", status: 400 });
    expect(claimed.size).toBe(0);
  });

  it("a fail verdict needs no such consistency (failing is always allowed)", async () => {
    const { d } = deps();
    expect((await evaluateSignRequest(request({ report: report({ verdict: "fail", regressionTestFailsBeforeFix: false, findings: [{ severity: "high", message: "x" }] }) }), d)).ok).toBe(true);
  });

  it("a transient GitHub failure does not consume the run: a retry can still be signed", async () => {
    let fail = true;
    const { d } = deps({ livePull: () => { if (fail) { fail = false; return Promise.reject(new Error("timeout")); } return Promise.resolve({ state: "open", headSha: SHA }); } });
    expect(await evaluateSignRequest(request(), d)).toMatchObject({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect((await evaluateSignRequest(request(), d)).ok).toBe(true);
  });

  it("a failing replay store fails closed (nothing signed)", async () => {
    const { d } = deps({ replay: { claim: () => { throw new Error("EIO"); }, lookup: () => null } });
    expect(await evaluateSignRequest(request(), d)).toEqual({ ok: false, code: "INTERNAL", status: 500 });
  });
});
