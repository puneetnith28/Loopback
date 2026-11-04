import { describe, expect, it } from "vitest";
import { loadSwitchConfig } from "../../apps/switch-gate/src/config.js";
import { migrate, openDatabase } from "../../apps/switch-gate/src/persistence/db.js";
import { kvSet } from "../../apps/switch-gate/src/persistence/repos.js";
import { StoredConnectionError, sqliteConnectionStore } from "../../apps/switch-gate/src/switch/store.js";

function db() {
  const d = openDatabase(":memory:");
  migrate(d);
  return d;
}

describe("sqliteConnectionStore", () => {
  it("round-trips the connection record, including a generation above 2^32", () => {
    const store = sqliteConnectionStore(db());
    expect(store.load()).toBeNull();
    store.save({ connectionId: "c1", generation: 8589934597, position: { s: 3, "r:room-1": 12 } });
    expect(store.load()).toEqual({ connectionId: "c1", generation: 8589934597, position: { s: 3, "r:room-1": 12 } });
  });

  it.each([
    ["not JSON", "{"],
    ["an unsafe generation", JSON.stringify({ connectionId: "c1", generation: 2 ** 53, position: null })],
    ["a missing connection id", JSON.stringify({ generation: 1, position: null })],
    ["a bad position key", JSON.stringify({ connectionId: "c1", generation: 1, position: { x: 1 } })],
  ])("fails closed on %s instead of starting a fresh connection", (_n, raw) => {
    const d = db();
    kvSet(d, "switch_connection", raw);
    expect(() => sqliteConnectionStore(d).load()).toThrow(StoredConnectionError);
  });
});

describe("Switch config: gate mention", () => {
  const env = {
    SWITCH_BRIDGE_URL: "http://127.0.0.1:37203", SWITCH_AGENT_ID: "a", SWITCH_AGENT_API_KEY: "k",
    SWITCH_ROOM_ID: "r", SWITCH_SELF_ID: "@switch-agent-9cb69676:localhost",
    SWITCH_POLICY_USER_IDS: "2a8934be-9a66-4944-a410-456e9e23b98c",
    SWITCH_POLICY_AGENT_IDS: "11111111-2222-4333-8444-555555555555",
  };

  it("defaults to the registered agent name, not the participant id", () => {
    expect(loadSwitchConfig(env).gateMention).toBe("@loopback-gate");
  });

  it("rejects a mention that is not @ followed by an agent name", () => {
    expect(() => loadSwitchConfig({ ...env, SWITCH_GATE_MENTION: "loopback-gate" })).toThrow(/SWITCH_GATE_MENTION/);
  });
});
