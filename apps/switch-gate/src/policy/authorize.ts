import type { CommandKind, ReasonCode } from "@loopback/contracts";

/**
 * Roles of an admitted sender. Agents never get a role: admission (policy/admission.ts)
 * routes the configured fixer and verifier to the report path and refuses delegated,
 * platform and unaddressed messages before any role is resolved.
 */
export type Role = "maintainer" | "reporter" | "outsider";

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

/** Commands that change authorization or repository state. Off unless explicitly enabled. */
export const PRIVILEGED: ReadonlySet<CommandKind> = new Set<CommandKind>(["verify", "approve", "reject", "merge", "retask"]);

export type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReasonCode; readonly message: string };

export function authorize(kind: CommandKind, role: Role, policy: Pick<IdentityPolicy, "privilegedEnabled">): Decision {
  const allowed = ALLOWED[kind];
  if (!allowed.includes(role)) {
    return { ok: false, code: "NOT_AUTHORIZED", message: `${kind} requires: ${allowed.join(", ")}` };
  }
  if (PRIVILEGED.has(kind) && policy.privilegedEnabled !== true) {
    return { ok: false, code: "PRIVILEGED_DISABLED", message: `${kind} is disabled (LOOPBACK_PRIVILEGED_ENABLED is not true)` };
  }
  return { ok: true };
}

export function allowedRoles(kind: CommandKind): readonly Role[] {
  return ALLOWED[kind];
}
