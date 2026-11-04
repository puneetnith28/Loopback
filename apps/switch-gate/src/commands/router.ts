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
import { authorize, roleOf, type IdentityPolicy, type Role } from "../policy/authorize.js";
import { USAGE, parseCommand } from "./parse.js";

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
  approve(ctx: CommandContext, caseId: string, shortSha: string): Promise<Reply>;
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
  readonly fixerId: string;
  readonly verifierId: string;
  readonly gateMention: string;
  readonly repo: string;
  readonly quorum: number;
  readonly requiredChecks: readonly string[];
  readonly privileged: PrivilegedHandlers;
  readonly handoff: FixerHandoff;
  readonly agents: AgentInbox;
  readonly now: () => Date;
}

function startsWithMention(body: string, mention: string): boolean {
  return body.trim().toLowerCase().startsWith(mention.toLowerCase());
}

export class Router {
  constructor(private readonly d: RouterDeps) {}

  /** Handle one inbound message. Redelivered events are no-ops. */
  async handle(msg: InboundMessage): Promise<void> {
    const { db, now } = this.d;
    if (isProcessed(db, msg.eventId)) return;

    const agent = msg.sender === this.d.fixerId ? "fixer" : msg.sender === this.d.verifierId ? "verifier" : null;
    if (agent !== null && !startsWithMention(msg.body, this.d.gateMention)) {
      await this.d.agents.onAgentMessage(msg, agent);
      markProcessed(db, msg.eventId, now());
      return;
    }

    const parsed = parseCommand(msg.body, this.d.gateMention);
    if (!parsed.ok) {
      if (!startsWithMention(msg.body, this.d.gateMention)) {
        markProcessed(db, msg.eventId, now()); // not addressed to us
        return;
      }
      await this.refuse(msg, null, "UNKNOWN_COMMAND", { detail: `${parsed.error}. Usage:\n${USAGE}` }, "unknown");
      return;
    }

    const command = parsed.command;
    const role = roleOf(msg, this.d.identity);
    const decision = authorize(command.kind, role, this.d.identity);
    if (!decision.ok) {
      const caseId = "caseId" in command ? command.caseId : null;
      await this.refuse(msg, caseId, decision.code, { command: command.kind, sender: msg.sender, ...(caseId !== null ? { caseId } : {}) }, command.kind);
      return;
    }

    const reply = await this.dispatch(command, { msg, role });
    if (command.kind !== "report") markProcessed(db, msg.eventId, now());
    if (reply) await this.post(msg, reply);
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
        return this.d.privileged.approve(ctx, command.caseId, command.shortSha);
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
  ): Promise<void> {
    const { db, now } = this.d;
    const knownCase = caseId !== null && getCase(db, caseId) !== undefined ? caseId : null;
    db.transaction(() => {
      append(db, {
        caseId: knownCase, actorId: msg.sender, type: "command.refused", reasonCode: code,
        payload: { command, eventId: msg.eventId, addressed: msg.addressed },
      }, now());
      markProcessed(db, msg.eventId, now());
    })();
    await this.post(msg, { text: formatReason(code, ctx), caseId: knownCase });
  }

  private async post(msg: InboundMessage, reply: Reply): Promise<void> {
    await this.d.chat.post(msg.roomId, withCaseTag(reply.text, reply.caseId, msg.threadId), msg.threadId);
  }
}
