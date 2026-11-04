import type { ReasonCode } from "@loopback/contracts";
import type { RoomKind } from "./authorize.js";

/**
 * Message admission: the single step every inbound message passes before any
 * command parser or handler runs.
 *
 * Live switch-core 0.31.0 attribution (observed 2026-11-03): people arrive with
 * `sender_kind: null` and `on_behalf_of: null`; the server sets `sender_kind` only to
 * "platform" for platform-carried messages. `addressed` is true only when the gate
 * is mentioned AND the gate's Switch addressing policy admits the sender (server
 * source: delivery/recipient.py `_gate_addressed`). So a message reaches a handler
 * only if Switch's policy admitted the sender, independently of Loopback's own
 * exact-id lists, which are applied after admission.
 *
 * Inputs are deliberately limited to the fields below: display names, sender roles
 * and any other descriptive field cannot influence the outcome.
 */

export interface AdmissionMessage {
  /** The Switch room the message arrived in (from the frame, never from its content). */
  readonly roomId: string;
  /** Opaque Switch participant id, matched exactly (no case folding, no trimming). */
  readonly sender: string;
  readonly senderKind: string | null;
  readonly onBehalfOf: string | null;
  readonly addressed: boolean;
  readonly body: string;
}

export interface AdmissionPolicy {
  /** The gate's own participant id. */
  readonly selfId: string;
  /** Exact participant ids of the fixer and verifier agents. */
  readonly fixerId: string;
  readonly verifierId: string;
  /** How the gate is mentioned at the start of a command, e.g. "@loopback-gate". */
  readonly gateMention: string;
  /** D26: the private maintainers' room and the public intake room (distinct). */
  readonly maintainerRoomId: string;
  readonly intakeRoomId: string;
}

export type AdmissionCode = Extract<ReasonCode, "NOT_ADDRESSED" | "DELEGATED_SENDER" | "PLATFORM_SENDER" | "UNRECOGNISED_SENDER_KIND" | "WRONG_ROOM">;

export type Admission =
  /** The gate's own message: dropped silently. */
  | { readonly kind: "self" }
  /** Room chatter that neither names the gate nor comes from a configured agent: dropped silently. */
  | { readonly kind: "ignore" }
  /** Aimed at the gate but not admissible: audited, never answered, never parsed. */
  | { readonly kind: "refused"; readonly code: AdmissionCode }
  /** An addressed report from the exact fixer or verifier id, in the maintainers' room; never a command. */
  | { readonly kind: "agent_report"; readonly agent: "fixer" | "verifier" }
  /** An addressed message from a person: may be parsed as a command in this room; roles are decided later. */
  | { readonly kind: "command"; readonly room: RoomKind };

/** The only sender kind a person carries on the verified install. Anything else fails closed. */
const ACCEPTED_SENDER_KIND = null;

/** Throws on a policy admission cannot run with. Call at startup, not only per message. */
export function assertAdmissionPolicy(p: AdmissionPolicy): void {
  const ids = [p.selfId, p.fixerId, p.verifierId];
  const rooms = [p.maintainerRoomId, p.intakeRoomId];
  if (
    ids.some((id) => id.trim() === "") || new Set(ids).size !== ids.length ||
    rooms.some((r) => r.trim() === "") || p.maintainerRoomId === p.intakeRoomId ||
    !/^@[a-z0-9][a-z0-9._-]*$/.test(p.gateMention)
  ) {
    throw new Error("invalid admission policy: self, fixer and verifier ids must be distinct and non-empty, the two rooms distinct and non-empty, and the mention must be @name");
  }
}

/**
 * Whether the body starts with the gate mention, matched like the command parser
 * (commands/parse.ts): ASCII case-insensitive only, so Unicode case folding (e.g. the
 * Kelvin sign folding to "k") cannot make a different string name the gate.
 */
export function namesGate(body: string, gateMention: string): boolean {
  const escaped = gateMention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?![A-Za-z0-9._-])`, "i").test(body.trim());
}

export function admit(msg: AdmissionMessage, policy: AdmissionPolicy): Admission {
  assertAdmissionPolicy(policy);
  if (msg.sender === policy.selfId) return { kind: "self" };
  // The transport rejects frames without a sender; this keeps admission closed on its own.
  if (msg.sender.trim() === "") return { kind: "refused", code: "UNRECOGNISED_SENDER_KIND" };

  const agent = msg.sender === policy.fixerId ? "fixer" : msg.sender === policy.verifierId ? "verifier" : null;
  // Only messages aimed at the gate are audited; ordinary room chatter is not.
  const aimed = msg.addressed || agent !== null || namesGate(msg.body, policy.gateMention);
  if (!aimed) return { kind: "ignore" };

  const room: RoomKind | null =
    msg.roomId === policy.maintainerRoomId ? "maintainers" : msg.roomId === policy.intakeRoomId ? "intake" : null;
  // A room the gate does not serve never yields authority (the transport drops these too).
  if (room === null) return { kind: "refused", code: "WRONG_ROOM" };

  if (msg.senderKind === "platform") return { kind: "refused", code: "PLATFORM_SENDER" };
  if (msg.onBehalfOf !== null) return { kind: "refused", code: "DELEGATED_SENDER" };
  if (msg.senderKind !== ACCEPTED_SENDER_KIND) return { kind: "refused", code: "UNRECOGNISED_SENDER_KIND" };
  if (msg.addressed !== true) return { kind: "refused", code: "NOT_ADDRESSED" };

  if (agent !== null) {
    // Agents report only in the maintainers' room. The intake rule admits no agents, so an
    // addressed agent message there means the policy is not what Loopback expects.
    return room === "maintainers" ? { kind: "agent_report", agent } : { kind: "refused", code: "WRONG_ROOM" };
  }
  return { kind: "command", room };
}
