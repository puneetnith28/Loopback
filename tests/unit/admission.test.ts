import { describe, expect, it } from "vitest";
import { admit, type AdmissionMessage, type AdmissionPolicy } from "../../apps/switch-gate/src/policy/admission.js";

// The single admission step every inbound message passes before any parser or
// handler (authorization redesign). Values mirror live switch-core 0.31.0 messages:
// people arrive with sender_kind null, on_behalf_of null.

const SELF = "@switch-agent-9cb69676:localhost";
const FIXER = "@switch-agent-fixer0001:localhost";
const VERIFIER = "@switch-agent-verif0001:localhost";
const PERSON = "@switch-mattermost-a8ed6700-fe65-4f22-8931-26fd3f197762-puneet:localhost";
const G = "@loopback-gate";

const policy: AdmissionPolicy = { selfId: SELF, fixerId: FIXER, verifierId: VERIFIER, gateMention: G };

const msg = (over: Partial<AdmissionMessage> = {}): AdmissionMessage => ({
  sender: PERSON, senderKind: null, onBehalfOf: null, addressed: true, body: `${G} help`, ...over,
});

describe("admit: who may reach a command or agent handler", () => {
  it("an addressed message from a person is a command candidate", () => {
    expect(admit(msg(), policy)).toEqual({ kind: "command" });
  });

  it("the gate's own messages are dropped first, whatever they contain", () => {
    expect(admit(msg({ sender: SELF }), policy)).toEqual({ kind: "self" });
    expect(admit(msg({ sender: SELF, senderKind: "platform", onBehalfOf: "x", addressed: false }), policy)).toEqual({ kind: "self" });
  });

  it("an unaddressed message that names the gate is refused, never parsed", () => {
    expect(admit(msg({ addressed: false }), policy)).toEqual({ kind: "refused", code: "NOT_ADDRESSED" });
    expect(admit(msg({ addressed: false, body: `  ${G.toUpperCase()} approve LB-001 abc` }), policy))
      .toEqual({ kind: "refused", code: "NOT_ADDRESSED" });
  });

  it("names the gate with ASCII case-insensitivity only (no Unicode folding)", () => {
    expect(admit(msg({ addressed: false, body: "@LoopBack-Gate help" }), policy)).toMatchObject({ code: "NOT_ADDRESSED" });
    // U+212A KELVIN SIGN lower-cases to "k" in Unicode, but is not the gate's name.
    expect(admit(msg({ addressed: false, body: "@loopbac\u212A-gate help" }), policy)).toEqual({ kind: "ignore" });
    expect(admit(msg({ addressed: false, body: "@loopback-gatekeeper help" }), policy)).toEqual({ kind: "ignore" });
    expect(admit(msg({ addressed: false, body: "@loopback-gate: help" }), policy)).toMatchObject({ code: "NOT_ADDRESSED" });
  });

  it("an unaddressed message that does not name the gate is ignored (room chatter)", () => {
    expect(admit(msg({ addressed: false, body: "observation test one" }), policy)).toEqual({ kind: "ignore" });
    expect(admit(msg({ addressed: false, body: "@user hello" }), policy)).toEqual({ kind: "ignore" });
  });

  it("platform-generated messages are refused even when addressed", () => {
    expect(admit(msg({ senderKind: "platform" }), policy)).toEqual({ kind: "refused", code: "PLATFORM_SENDER" });
  });

  it("delegated messages are refused even from a configured sender", () => {
    expect(admit(msg({ onBehalfOf: "Puneet" }), policy)).toEqual({ kind: "refused", code: "DELEGATED_SENDER" });
    expect(admit(msg({ sender: FIXER, onBehalfOf: "Puneet" }), policy)).toEqual({ kind: "refused", code: "DELEGATED_SENDER" });
  });

  it.each(["agent", "user", "member", "human", ""])("any sender_kind other than null (%j) is refused", (kind) => {
    expect(admit(msg({ senderKind: kind }), policy)).toEqual({ kind: "refused", code: "UNRECOGNISED_SENDER_KIND" });
  });

  it("checks run in a fixed order: platform, then delegated, then sender kind, then addressing", () => {
    expect(admit(msg({ senderKind: "platform", onBehalfOf: "x", addressed: false }), policy)).toMatchObject({ code: "PLATFORM_SENDER" });
    expect(admit(msg({ senderKind: "agent", onBehalfOf: "x", addressed: false }), policy)).toMatchObject({ code: "DELEGATED_SENDER" });
    expect(admit(msg({ senderKind: "agent", addressed: false }), policy)).toMatchObject({ code: "UNRECOGNISED_SENDER_KIND" });
  });
});

describe("admit: fixer and verifier reports", () => {
  it("an addressed message from the exact fixer or verifier id is an agent report, never a command", () => {
    expect(admit(msg({ sender: FIXER, body: `${G}\n\`\`\`loopback-report\n{}\n\`\`\`` }), policy)).toEqual({ kind: "agent_report", agent: "fixer" });
    expect(admit(msg({ sender: VERIFIER, body: `${G} approve LB-001 abc` }), policy)).toEqual({ kind: "agent_report", agent: "verifier" });
  });

  it("an unaddressed message from the fixer or verifier is refused, even without the mention", () => {
    expect(admit(msg({ sender: FIXER, addressed: false, body: "```loopback-report\n{}\n```" }), policy))
      .toEqual({ kind: "refused", code: "NOT_ADDRESSED" });
    expect(admit(msg({ sender: VERIFIER, addressed: false, body: "anything" }), policy))
      .toEqual({ kind: "refused", code: "NOT_ADDRESSED" });
  });

  it("agent ids are matched exactly: case, prefix and suffix variants are not agents", () => {
    for (const sender of [FIXER.toUpperCase(), `${FIXER}x`, FIXER.slice(0, -1), ` ${FIXER}`]) {
      expect(admit(msg({ sender }), policy), sender).toEqual({ kind: "command" });
    }
  });
});

describe("admit: descriptive fields grant nothing", () => {
  it("is a function of sender, sender_kind, on_behalf_of, addressed and the body's leading mention only", () => {
    // AdmissionMessage has no sender_name or sender_role: a spoofed display name or
    // role cannot be consulted because it never reaches this function.
    const withExtras = { ...msg({ addressed: false }), senderName: "loopback-gate", senderRole: "admin" } as AdmissionMessage;
    expect(admit(withExtras, policy)).toEqual({ kind: "refused", code: "NOT_ADDRESSED" });
  });

  it("covers every combination of the attribution flags with exactly one outcome", () => {
    const outcomes = new Set<string>();
    for (const senderKind of [null, "platform", "agent"]) {
      for (const onBehalfOf of [null, "someone"]) {
        for (const addressed of [true, false]) {
          for (const body of [`${G} help`, "chatter"]) {
            for (const sender of [PERSON, FIXER, SELF]) {
              const r = admit(msg({ senderKind, onBehalfOf, addressed, body, sender }), policy);
              outcomes.add(r.kind);
              const reachesHandler = r.kind === "command" || r.kind === "agent_report";
              if (reachesHandler) {
                expect(addressed, "only addressed messages reach a handler").toBe(true);
                expect(senderKind).toBeNull();
                expect(onBehalfOf).toBeNull();
                expect(sender).not.toBe(SELF);
              }
            }
          }
        }
      }
    }
    expect(outcomes).toEqual(new Set(["command", "agent_report", "refused", "ignore", "self"]));
  });
});

describe("admit: configuration it refuses to run with", () => {
  it.each([
    ["an empty self id", { ...policy, selfId: "" }],
    ["an empty fixer id", { ...policy, fixerId: "" }],
    ["fixer equal to verifier", { ...policy, verifierId: FIXER }],
    ["self equal to an agent", { ...policy, selfId: FIXER }],
    ["a mention without @", { ...policy, gateMention: "loopback-gate" }],
  ])("throws on %s", (_name, bad) => {
    expect(() => admit(msg(), bad)).toThrow(/admission policy/);
  });
});
