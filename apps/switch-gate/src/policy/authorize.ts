import type { CommandKind, ReasonCode } from "@loopback/contracts";

export type Role = "maintainer" | "reporter" | "agent" | "outsider";

export interface IdentityPolicy {
  readonly maintainers: ReadonlySet<string>;
  readonly reporters: ReadonlySet<string>;
  readonly agentSenders: ReadonlySet<string>;
  /** The human sender_kind verified on the real Switch install; null = not yet verified (D16, Q3). */
  readonly humanSenderKind: string | null;
}

export interface SenderAttribution {
  readonly sender: string;
  readonly senderKind: string | null;
  readonly onBehalfOf: string | null;
}

/**
 * Resolve a sender's role. Attribution is checked before any allowlist (D16):
 * a message sent on behalf of someone, from a configured agent id, or with a
 * sender kind other than the verified human kind is always an agent message,
 * even if its sender id is a maintainer's. Display names are never consulted.
 */
export function roleOf(msg: SenderAttribution, policy: IdentityPolicy): Role {
  if (policy.agentSenders.has(msg.sender)) return "agent";
  if (msg.onBehalfOf !== null) return "agent";
  // Until the human sender kind is verified on the real install (Q3), nobody can be
  // proven human, so nobody gets more than outsider rights (help and whoami only).
  if (policy.humanSenderKind === null) return "outsider";
  if (msg.senderKind !== policy.humanSenderKind) return "agent";
  if (policy.maintainers.has(msg.sender)) return "maintainer";
  if (policy.reporters.has(msg.sender)) return "reporter";
  return "outsider";
}

const ALLOWED: Readonly<Record<CommandKind, readonly Role[]>> = {
  help: ["maintainer", "reporter", "outsider"],
  whoami: ["maintainer", "reporter", "outsider"],
  report: ["maintainer", "reporter"],
  status: ["maintainer", "reporter"],
  audit: ["maintainer", "reporter"],
  verify: ["maintainer"],
  approve: ["maintainer"],
  reject: ["maintainer"],
  merge: ["maintainer"],
  retask: ["maintainer"],
};

/** Commands that change authorization state. Disabled until attribution is verified (D16). */
export const PRIVILEGED: ReadonlySet<CommandKind> = new Set<CommandKind>(["verify", "approve", "reject", "merge", "retask"]);

export type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReasonCode; readonly message: string };

export function authorize(kind: CommandKind, role: Role, policy: Pick<IdentityPolicy, "humanSenderKind">): Decision {
  const allowed = ALLOWED[kind];
  if (!allowed.includes(role)) {
    return { ok: false, code: "NOT_AUTHORIZED", message: `${kind} requires: ${allowed.join(", ")}` };
  }
  if (PRIVILEGED.has(kind) && policy.humanSenderKind === null) {
    return {
      ok: false,
      code: "PRIVILEGED_DISABLED",
      message: `${kind} is disabled until sender attribution is verified on this Switch install`,
    };
  }
  return { ok: true };
}

export function allowedRoles(kind: CommandKind): readonly Role[] {
  return ALLOWED[kind];
}
