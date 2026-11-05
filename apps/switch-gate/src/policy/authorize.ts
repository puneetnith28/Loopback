import type { CommandKind, ReasonCode } from "@loopback/contracts";

/**
 * Roles of an admitted sender. Agents never get a role: admission (policy/admission.ts)
 * routes the configured fixer and verifier to the report path and refuses delegated,
 * platform and unaddressed messages before any role is resolved.
 */
export type Role = "maintainer" | "reporter" | "outsider";

/**
 * Which room a command arrived in (D26). The maintainers' room is private (Switch admits
 * only the listed maintainers and agents); the intake room is public (Switch admits any
 * person, no agents). Authority never crosses rooms: nothing privileged exists in intake.
 */
export type RoomKind = "maintainers" | "intake";

export interface IdentityPolicy {
  /** Exact Switch participant ids (the message `sender`). Never names or roles. */
  readonly maintainers: ReadonlySet<string>;
  readonly reporters: ReadonlySet<string>;
  /** Explicit operator switch for privileged commands. Off unless set to true. */
  readonly privilegedEnabled: boolean;
}

/**
 * Resolve the role of a sender that has already passed admission. The sender id is
 * compared exactly against the configured lists; display names, `sender_role` and
 * `sender_kind` are never consulted.
 */
export function roleOf(sender: string, policy: Pick<IdentityPolicy, "maintainers" | "reporters">): Role {
  if (policy.maintainers.has(sender)) return "maintainer";
  if (policy.reporters.has(sender)) return "reporter";
  return "outsider";
}

/** Maintainers' room: who may run each command. */
const MAINTAINER_ROOM: Readonly<Record<CommandKind, readonly Role[]>> = {
  help: ["maintainer", "reporter", "outsider"],
  whoami: ["maintainer", "reporter", "outsider"],
  report: ["maintainer", "reporter"],
  status: ["maintainer", "reporter"],
  audit: ["maintainer", "reporter"],
  why: ["maintainer", "reporter"],
  board: ["maintainer", "reporter"],
  team: ["maintainer", "reporter"],
  verify: ["maintainer"],
  approve: ["maintainer"],
  reject: ["maintainer"],
  merge: ["maintainer"],
  retask: ["maintainer"],
  accept: ["maintainer"],
  decline: ["maintainer"],
};

/**
 * Intake room: the only commands that exist there, for anyone Switch admits (D26).
 * `status` is limited to the sender's own reports by the router.
 */
export const INTAKE_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>(["help", "report", "status"]);

/** Commands that change authorization or repository state. Off unless explicitly enabled. */
export const PRIVILEGED: ReadonlySet<CommandKind> = new Set<CommandKind>(["verify", "approve", "reject", "merge", "retask"]);

export type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReasonCode; readonly message: string };

export function authorize(kind: CommandKind, role: Role, room: RoomKind, policy: Pick<IdentityPolicy, "privilegedEnabled">): Decision {
  if (room === "intake") {
    return INTAKE_COMMANDS.has(kind) ? { ok: true } : { ok: false, code: "WRONG_ROOM", message: `${kind} is not available in the intake room` };
  }
  const allowed = MAINTAINER_ROOM[kind];
  if (!allowed.includes(role)) {
    return { ok: false, code: "NOT_AUTHORIZED", message: `${kind} requires: ${allowed.join(", ")}` };
  }
  if (PRIVILEGED.has(kind) && policy.privilegedEnabled !== true) {
    return { ok: false, code: "PRIVILEGED_DISABLED", message: `${kind} is disabled (LOOPBACK_PRIVILEGED_ENABLED is not true)` };
  }
  return { ok: true };
}

export function allowedRoles(kind: CommandKind): readonly Role[] {
  return MAINTAINER_ROOM[kind];
}

/** The commands this sender can actually run here (D27 role-filtered help). */
export function availableCommands(room: RoomKind, role: Role, policy: Pick<IdentityPolicy, "privilegedEnabled">): readonly CommandKind[] {
  const all = Object.keys(MAINTAINER_ROOM) as CommandKind[];
  return all.filter((k) => authorize(k, role, room, policy).ok);
}
