import { describe, expect, it, vi } from "vitest";
import { checkPolicy, verifyAddressingPolicy, type PolicyExpectation } from "../../apps/switch-gate/src/switch/policy-check.js";

// The startup self-check. The expected policy below is the one applied to the live
// loopback-gate on 2026-11-03 (plus an agent id, which the live policy does not yet have).

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const ROOM = "8aeb4229-d129-47c8-93d6-ec4f37d623e3";
const USER = "2a8934be-9a66-4944-a410-456e9e23b98c";
const FIXER_AGENT = "11111111-2222-4333-8444-555555555555";
const expected: PolicyExpectation = { roomId: ROOM, userIds: new Set([USER]), agentIds: new Set([FIXER_AGENT]) };

const rule = (over: Record<string, unknown> = {}) => ({
  rooms: [ROOM], room_groups: "*", users: [USER], agents: [FIXER_AGENT], owner: false, owner_agents: false, platform: false, ...over,
});
const policy = (...rules: object[]) => ({ rules });

describe("checkPolicy", () => {
  it("accepts exactly the expected single restrictive rule", () => {
    expect(checkPolicy(policy(rule()), expected)).toEqual({ ok: true });
  });

  it.each([
    ["no policy (open to anyone)", null, /open to anyone/],
    ["no rules (open to anyone)", policy(), /no rules/],
    ["two rules (OR widens it)", policy(rule(), rule()), /2 rules/],
    ["rooms wildcard", policy(rule({ rooms: "*" })), /rooms/],
    ["another room", policy(rule({ rooms: ["other"] })), /rooms/],
    ["the room plus another", policy(rule({ rooms: [ROOM, "other"] })), /rooms/],
    ["room_groups restricted differently", policy(rule({ room_groups: ["g"] })), /room_groups/],
    ["users wildcard", policy(rule({ users: "*" })), /users/],
    ["an extra user", policy(rule({ users: [USER, "33333333-2222-4333-8444-555555555555"] })), /users/],
    ["a missing user", policy(rule({ users: [] })), /users/],
    ["a duplicated user", policy(rule({ users: [USER, USER] })), /users/],
    ["agents wildcard", policy(rule({ agents: "*" })), /agents/],
    ["no agents", policy(rule({ agents: [] })), /agents/],
    ["owner admitted", policy(rule({ owner: true })), /owner must be false/],
    ["owner's agents admitted", policy(rule({ owner_agents: true })), /owner_agents/],
    ["platform admitted", policy(rule({ platform: true })), /platform/],
    ["an unknown rule field", policy(rule({ guests: "*" })), /unexpected shape/],
    ["an unknown policy field", { rules: [rule()], mode: "open" }, /unexpected shape/],
    ["a malformed value", policy(rule({ owner: "false" })), /unexpected shape/],
    ["not an object", "anyone", /unexpected shape/],
  ])("fails closed on %s", (_n, p, reason) => {
    const r = checkPolicy(p, expected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("is order-insensitive for the id lists", () => {
    const two = { ...expected, userIds: new Set([USER, "33333333-2222-4333-8444-555555555555"]) };
    expect(checkPolicy(policy(rule({ users: ["33333333-2222-4333-8444-555555555555", USER] })), two)).toEqual({ ok: true });
  });
});

describe("verifyAddressingPolicy (read with the gate's own key)", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(() => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
  const opts = (f: ReturnType<typeof vi.fn>) => ({ bridgeUrl: "http://127.0.0.1:37203/", agentId: AGENT, apiKey: "test-key", fetch: f as unknown as typeof fetch });

  it("reads get_agent_detail for its own id with the bearer key, and passes a matching policy", async () => {
    const f = respond(200, { result: { id: AGENT, name: "loopback-gate", addressing_policy: policy(rule()) } });
    expect(await verifyAddressingPolicy(opts(f), expected)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:37203/agents/${AGENT}/ops/get_agent_detail`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: AGENT });
  });

  it("fails closed on the live policy as applied today (no agents admitted yet)", async () => {
    const live = { rules: [{ rooms: [ROOM], room_groups: "*", users: [USER], agents: [], owner: false, owner_agents: false, platform: false }] };
    const r = await verifyAddressingPolicy(opts(respond(200, { result: { id: AGENT, addressing_policy: live } })), expected);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/agents/) as unknown, unreadable: false });
  });

  it.each([
    ["an HTTP error", respond(401, '{"detail":"Invalid credentials"}'), /HTTP 401/],
    ["a non-JSON body", respond(200, "<html>"), /not JSON/],
    ["a body without result", respond(200, { ok: true }), /unexpected shape/],
    ["a missing policy field", respond(200, { result: { id: AGENT } }), /unexpected shape/],
    ["an explicit null policy (open to anyone)", respond(200, { result: { id: AGENT, addressing_policy: null } }), /open to anyone/],
    ["another agent's detail", respond(200, { result: { id: "someone-else", addressing_policy: policy(rule()) } }), /different agent/],
    ["a network failure", vi.fn(() => Promise.reject(new TypeError("fetch failed"))), /could not read/],
  ])("fails closed on %s", async (_n, f, reason) => {
    const r = await verifyAddressingPolicy(opts(f), expected);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(reason);
      expect(r.reason).not.toContain("test-key");
    }
  });
});
