import type { Command, InboundMessage, ReasonCode } from "@loopback/contracts";
import { append, listRecent } from "../audit/index.js";
import { createCase, transitionInTx } from "../cases/service.js";
import { withCaseTag, type ChatPort } from "../chat/port.js";
import { renderAuditTable, renderStatus } from "../chat/format.js";
import { formatReason, safe } from "../chat/reasons.js";
import type { Db } from "../persistence/db.js";
import {
  getCase,
  isProcessed,
  latestCi,
  latestRunForHead,
  listApprovals,
  markProcessed,
  type CaseRecord,
} from "../persistence/repos.js";
import { HaltedError } from "../cases/halt.js";
import { admit, assertAdmissionPolicy, type AdmissionCode, type AdmissionPolicy } from "../policy/admission.js";
import { authorize, roleOf, type IdentityPolicy, type Role } from "../policy/authorize.js";
import { USAGE, parseCommand } from "./parse.js";

/**
 * Audit-spam bound for admission refusals: an ordinary refusal (NOT_ADDRESSED from a
 * person) is audited at most once per sender per window, and the next audited row
 * records how many were suppressed. Attribution refusals and refusals of the configured
 * fixer/verifier are security or availability evidence and are always audited.
 */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;
const REFUSAL_AUDIT_MAX_KEYS = 1_000;
const NEVER_THROTTLED: ReadonlySet<AdmissionCode> = new Set<AdmissionCode>(["DELEGATED_SENDER", "PLATFORM_SENDER", "UNRECOGNISED_SENDER_KIND"]);

export interface Reply {
  readonly text: string;
  readonly caseId: string | null;
}

export interface CommandContext {
  readonly msg: InboundMessage;
  readonly role: Role;
}

/** Privileged command implementations (verification, approvals, merge gate). */
export interface PrivilegedHandlers {
  verify(ctx: CommandContext, caseId: string): Promise<Reply>;
  approve(ctx: CommandContext, caseId: string, sha: string): Promise<Reply>;
  reject(ctx: CommandContext, caseId: string, reason: string): Promise<Reply>;
  merge(ctx: CommandContext, caseId: string): Promise<Reply>;
  retask(ctx: CommandContext, caseId: string, note: string): Promise<Reply>;
}

/** Tasks the fixer for a new case. check() runs before any state change (D17 base check). */
export interface FixerHandoff {
  check(c: CaseRecord): Promise<ReasonCode | null>;
  message(c: CaseRecord): string;
}

/** Receives messages from the configured fixer and verifier agents. */
export interface AgentInbox {
  onAgentMessage(msg: InboundMessage, agent: "fixer" | "verifier"): Promise<void>;
}

export interface RouterDeps {
  readonly db: Db;
  readonly chat: ChatPort;
  readonly identity: IdentityPolicy;
  /** Admission inputs: the gate's own id, the exact fixer/verifier ids and the gate mention. */
  readonly admission: AdmissionPolicy;
  readonly repo: string;
  readonly quorum: number;
  readonly requiredChecks: readonly string[];
  readonly privileged: PrivilegedHandlers;
  readonly handoff: FixerHandoff;
  readonly agents: AgentInbox;
  readonly now: () => Date;
}

export class Router {
  /** Recently audited (code, sender) refusals: when, and how many were suppressed since. Bounded. */
  private readonly recentRefusals = new Map<string, { at: number; suppressed: number; sender: string; code: AdmissionCode }>();

  constructor(private readonly d: RouterDeps) {
    // Fail at construction (startup), not on every message.
    assertAdmissionPolicy(d.admission);
  }

  /**
   * Handle one inbound message. Redelivered events are no-ops. Every message passes
   * admission first: only an addressed report from the exact fixer/verifier id reaches
   * the agent inbox, and only an addressed message from a person reaches the parser.
   */
  async handle(msg: InboundMessage): Promise<void> {
    const { db, now } = this.d;
    if (isProcessed(db, msg.eventId)) return;
    this.flushExpiredRefusals(now().getTime());

    const admission = admit(msg, this.d.admission);
    switch (admission.kind) {
      case "self":
      case "ignore":
        markProcessed(db, msg.eventId, now());
        return;
      case "refused":
        // Audited, never answered: Switch already declined these, and replying could loop.
        // At most one audit row per sender per window, so a refused sender cannot flood the log.
        if (this.shouldAuditRefusal(msg.sender, admission.code)) {
          await this.refuse(msg, null, admission.code, {}, "admission", { reply: false });
        } else {
          markProcessed(db, msg.eventId, now());
        }
        return;
      case "agent_report":
        await this.d.agents.onAgentMessage(msg, admission.agent);
        markProcessed(db, msg.eventId, now());
        return;
      case "command":
        break;
    }

    const parsed = parseCommand(msg.body, this.d.admission.gateMention);
    if (!parsed.ok) {
      await this.refuse(msg, null, "UNKNOWN_COMMAND", { detail: `${parsed.error}. Usage:\n${USAGE}` }, "unknown");
      return;
    }

    const command = parsed.command;
    const role = roleOf(msg.sender, this.d.identity);
    const decision = authorize(command.kind, role, this.d.identity);
    if (!decision.ok) {
      const caseId = "caseId" in command ? command.caseId : null;
      await this.refuse(msg, caseId, decision.code, { command: command.kind, sender: msg.sender, ...(caseId !== null ? { caseId } : {}) }, command.kind);
      return;
    }

    let reply: Reply | null;
    try {
      reply = await this.dispatch(command, { msg, role });
    } catch (e) {
      if (!(e instanceof HaltedError)) throw e;
      // Halted mid-command: record it and mark the event processed, so it is never
      // re-run after a restart. No reply: posting is refused once the gate has stopped.
      const caseId = "caseId" in command ? command.caseId : null;
      await this.refuse(msg, caseId, "GATE_HALTED", {}, command.kind, { reply: false });
      return;
    }
    if (command.kind !== "report") markProcessed(db, msg.eventId, now());
    if (reply) await this.post(msg, reply);
  }

  /**
   * Whether to write an audit row for this admission refusal. Throttled refusals are
   * counted and reported in a summary row when their window closes. Fails toward
   * auditing: when the tracking table is full of live entries, the refusal is audited.
   */
  private shouldAuditRefusal(sender: string, code: AdmissionCode): boolean {
    const a = this.d.admission;
    if (NEVER_THROTTLED.has(code) || sender === a.fixerId || sender === a.verifierId) return true;
    const t = this.d.now().getTime();
    this.flushExpiredRefusals(t);
    const key = `${code}\u0000${sender}`;
    const entry = this.recentRefusals.get(key);
    if (entry !== undefined) {
      entry.suppressed += 1;
      return false;
    }
    // Table full of live entries: audit untracked rather than lose the evidence.
    if (this.recentRefusals.size >= REFUSAL_AUDIT_MAX_KEYS) return true;
    this.recentRefusals.set(key, { at: t, suppressed: 0, sender, code });
    return true;
  }

  /** Close expired windows; a window that suppressed refusals leaves a summary audit row. */
  private flushExpiredRefusals(t: number): void {
    for (const [key, v] of this.recentRefusals) {
      if (t - v.at < REFUSAL_AUDIT_WINDOW_MS) continue;
      this.recentRefusals.delete(key);
      if (v.suppressed > 0) {
        append(this.d.db, {
          caseId: null, actorId: v.sender, type: "command.refused", reasonCode: v.code,
          payload: { command: "admission", suppressed: v.suppressed, windowStartedAt: new Date(v.at).toISOString() },
        }, this.d.now());
      }
    }
  }

  private async dispatch(command: Command, ctx: CommandContext): Promise<Reply | null> {
    switch (command.kind) {
      case "help":
        return { text: `Loopback commands (your role: ${ctx.role}):\n${USAGE}`, caseId: null };
      case "whoami":
        return { text: `Your participant id: ${safe(ctx.msg.sender)} · role: ${ctx.role}`, caseId: null };
      case "report":
        return this.report(ctx.msg, command.text);
      case "status":
        return this.status(command.caseId);
      case "audit":
        return this.audit(command.caseId);
      case "verify":
        return this.d.privileged.verify(ctx, command.caseId);
      case "approve":
        return this.d.privileged.approve(ctx, command.caseId, command.sha);
      case "reject":
        return this.d.privileged.reject(ctx, command.caseId, command.reason);
      case "merge":
        return this.d.privileged.merge(ctx, command.caseId);
      case "retask":
        return this.d.privileged.retask(ctx, command.caseId, command.note);
    }
  }

  private async report(msg: InboundMessage, text: string): Promise<Reply | null> {
    const { db, now } = this.d;
    const created = createCase(db, {
      reporterId: msg.sender, roomId: msg.roomId, threadId: msg.threadId, repo: this.d.repo,
      reportText: text, sourceEventId: msg.eventId,
    }, now());
    if (!created) return null; // duplicate delivery of the same report

    const problem = await this.d.handoff.check(created);
    if (problem !== null) {
      db.transaction(() => transitionInTx(db, {
        caseId: created.id, to: "Blocked", actorId: "system", trigger: "system", reason: problem,
      }, now()))();
      return { text: formatReason(problem, { caseId: created.id }), caseId: created.id };
    }

    const tasked = db.transaction(() => {
      transitionInTx(db, { caseId: created.id, to: "Triaged", actorId: "system", trigger: "system", reason: null }, now());
      return transitionInTx(db, {
        caseId: created.id, to: "FixInProgress", actorId: "system", trigger: "system", reason: null, auditType: "fixer.started",
      }, now());
    })();
    // Persisted first, announced second (invariant 10).
    await this.d.chat.post(tasked.roomId, this.d.handoff.message(tasked), tasked.threadId);
    return { text: `${tasked.id} created · state Triaged → FixInProgress · tasked the fixer`, caseId: tasked.id };
  }

  private status(caseId: string): Reply {
    const c = getCase(this.d.db, caseId);
    if (!c) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    const head = c.headSha;
    const ci = this.d.requiredChecks.map((name) => {
      const e = head ? latestCi(this.d.db, c.id, head, name) : undefined;
      return { name, status: e?.status ?? null, conclusion: e?.conclusion ?? null };
    });
    const run = head ? latestRunForHead(this.d.db, c.id, head) : undefined;
    const approvals = head
      ? new Set(listApprovals(this.d.db, c.id)
          .filter((a) => a.headSha === head && a.decision === "approve" && this.d.identity.maintainers.has(a.approverId))
          .map((a) => a.approverId)).size
      : 0;
    return {
      text: renderStatus(c, { ci, verification: run ? { status: run.status, headSha: run.headSha } : null, approvals, quorum: this.d.quorum }),
      caseId: c.id,
    };
  }

  private audit(caseId: string): Reply {
    if (!getCase(this.d.db, caseId)) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    return { text: renderAuditTable(caseId, listRecent(this.d.db, caseId, 15)), caseId };
  }

  /** Record and announce a refusal. Every refusal is audited (invariant 9). */
  private async refuse(
    msg: InboundMessage,
    caseId: string | null,
    code: ReasonCode,
    ctx: Parameters<typeof formatReason>[1],
    command: string,
    opts: { readonly reply: boolean; readonly payload?: Readonly<Record<string, unknown>> } = { reply: true },
  ): Promise<void> {
    const { db, now } = this.d;
    const knownCase = caseId !== null && getCase(db, caseId) !== undefined ? caseId : null;
    db.transaction(() => {
      append(db, {
        caseId: knownCase, actorId: msg.sender, type: "command.refused", reasonCode: code,
        payload: { command, eventId: msg.eventId, addressed: msg.addressed, ...opts.payload },
      }, now());
      markProcessed(db, msg.eventId, now());
    })();
    if (opts.reply) await this.post(msg, { text: formatReason(code, ctx), caseId: knownCase });
  }

  private async post(msg: InboundMessage, reply: Reply): Promise<void> {
    await this.d.chat.post(msg.roomId, withCaseTag(reply.text, reply.caseId, msg.threadId), msg.threadId);
  }
}
