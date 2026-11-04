import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityConfig, SwitchConfig } from "../../apps/switch-gate/src/config.js";
import { preflight, watchPolicy } from "../../apps/switch-gate/src/startup.js";
import type { PolicyCheck } from "../../apps/switch-gate/src/switch/policy-check.js";

const AGENT = "71feb494-e294-4367-a8d4-ac99adfab999";
const ROOM = "8aeb4229-d129-47c8-93d6-ec4f37d623e3";
const USER = "2a8934be-9a66-4944-a410-456e9e23b98c";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";

const sw: SwitchConfig = {
  bridgeUrl: "http://127.0.0.1:37203", agentId: AGENT, apiKey: "test-key", roomId: ROOM,
  selfId: "@switch-agent-gate:localhost", gateMention: "@loopback-gate",
  policyUserIds: new Set([USER]), policyAgentIds: new Set([AGENT_ID]),
};
const id: IdentityConfig = {
  maintainers: new Set(["@switch-mattermost-x-puneet:localhost"]), reporters: new Set(),
  fixerId: "@switch-agent-fixer:localhost", verifierId: "@switch-agent-verifier:localhost",
  fixerAlias: "@loopback-fixer", verifierAlias: "@loopback-verifier", privilegedEnabled: false,
};
const matching = { result: { id: AGENT, addressing_policy: { rules: [{
  rooms: [ROOM], room_groups: "*", users: [USER], agents: [AGENT_ID], owner: false, owner_agents: false, platform: false,
}] } } };

describe("preflight", () => {
  it("passes when local identity is consistent and the live policy matches", async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(matching), { status: 200 })));
    expect(await preflight({ switch: sw, identity: id }, f as unknown as typeof fetch)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects inconsistent identity before any network call", async () => {
    const f = vi.fn();
    await expect(preflight({ switch: { ...sw, selfId: id.fixerId }, identity: id }, f as unknown as typeof fetch)).rejects.toThrow(/SWITCH_SELF_ID/);
    await expect(preflight({ switch: sw, identity: { ...id, maintainers: new Set([sw.selfId]) } }, f as unknown as typeof fetch)).rejects.toThrow(/LOOPBACK_MAINTAINERS/);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns the mismatch when the live policy is not the expected one", async () => {
    const open = { result: { id: AGENT, addressing_policy: null } };
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(open), { status: 200 })));
    expect(await preflight({ switch: sw, identity: id }, f as unknown as typeof fetch)).toMatchObject({ ok: false, unreadable: false });
  });
});

describe("watchPolicy", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ok: PolicyCheck = { ok: true };
  const wrongReason = "users must be exactly SWITCH_POLICY_USER_IDS";
  const wrong: PolicyCheck = { ok: false, reason: wrongReason, unreadable: false };
  const down: PolicyCheck = { ok: false, reason: "could not read the policy (HTTP 503)", unreadable: true };

  it("fails at once when the policy is read and found wrong", async () => {
    const results = [ok, wrong];
    const onFail = vi.fn();
    watchPolicy({ check: () => Promise.resolve(results.shift() ?? ok), intervalMs: 1000, maxUnreadable: 3, onFail });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFail).toHaveBeenCalledWith(wrongReason);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("tolerates unreadable results below the limit, resets on success, and fails closed at the limit", async () => {
    const results = [down, down, ok, down, down, down];
    const onFail = vi.fn();
    const onUnreadable = vi.fn();
    watchPolicy({ check: () => Promise.resolve(results.shift() ?? ok), intervalMs: 1000, maxUnreadable: 3, onFail, onUnreadable });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onFail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onUnreadable.mock.calls.map((c: unknown[]) => c[1] as number)).toEqual([1, 2, 1, 2, 3]);
  });

  it("stops checking once stopped", async () => {
    const check = vi.fn(() => Promise.resolve(wrong));
    const onFail = vi.fn();
    const w = watchPolicy({ check, intervalMs: 1000, maxUnreadable: 3, onFail });
    w.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});
