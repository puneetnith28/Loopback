import type { CaseState, Command, InboundMessage, ReasonCode } from "@loopback/contracts";
import { append, listRecent } from "../audit/index.js";
import { HaltedError } from "../cases/halt.js";
import { createCase, transitionInTx } from "../cases/service.js";
import { withCaseTag, type ChatPort } from "../chat/port.js";
import { renderAuditTable, renderStatus } from "../chat/format.js";
import { GENERIC_REFUSAL, formatReason, safe } from "../chat/reasons.js";
import type { Db } from "../persistence/db.js";
import {
  countReportsSince,
  findRecentReport,
  getCase,
  isProcessed,
  kvSet,
  latestCi,
  latestRunForHead,
  listApprovals,
  markProcessed,
  type CaseRecord,
} from "../persistence/repos.js";
import { admit, assertAdmissionPolicy, type AdmissionPolicy } from "../policy/admission.js";
import { authorize, availableCommands, roleOf, type IdentityPolicy, type Role, type RoomKind } from "../policy/authorize.js";
import { parseCommand, usageFor } from "./parse.js";

/**
 * Audit-spam bound for refusals from ordinary senders: audited at most once per
 * (code, sender) per window, with a summary row counting the suppressed ones when the
 * window closes. Attribution refusals and refusals of the configured fixer/verifier are
 * security or availability evidence and are always audited, as are maintainers' refusals.
 */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;
const REFUSAL_AUDIT_MAX_KEYS = 1_000;
const NEVER_THROTTLED: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["DELEGATED_SENDER", "PLATFORM_SENDER", "UNRECOGNISED_SENDER_KIND"]);

/** D27: visible refusals to ordinary senders, per (room, sender) per window; beyond it they are silent. */
export const VISIBLE_REFUSALS_PER_WINDOW = 3;
export const VISIBLE_REFUSAL_WINDOW_MS = 10 * 60_000;
const VISIBLE_REFUSAL_MAX_KEYS = 1_000;

/**
 * Security review H1: a maintainer triages exactly what the fixer will receive. Intake reports
 * are limited to what the triage notice shows in full, and invisible format characters
 * (zero-width, bidi, Unicode tags: \p{Cf}) are removed before the text is stored.
 */
export const INTAKE_MAX_REPORT_CHARS = 1000;
/** Security review M1: public reports awaiting triage, across all senders. Beyond it, intake pauses. */
export const INTAKE_MAX_PENDING = 50;
const INVISIBLE = /\p{Cf}/gu;

/** D26: duplicate reports from the same sender within this window are not filed twice. */
const DUPLICATE_REPORT_WINDOW_MS = 24 * 60 * 60_000;

export interface Reply {
  readonly text: string;
  readonly caseId: string | null;
}

export interface CommandContext {
  readonly msg: InboundMessage;
  readonly role: Role;
  readonly room: RoomKind;
}

/** Privileged command implementations (verification, approvals, merge gate). */
export interface PrivilegedHandlers {
  verify(ctx: CommandContext, caseId: string): Promise<Reply>;
  approve(ctx: CommandContext, caseId: string, sha: string): Promise<Reply>;
  reject(ctx: CommandContext, caseId: string, reason: string): Promise<Reply>;
  merge(ctx: CommandContext, caseId: string): Promise<Reply>;
  retask(ctx: CommandContext, caseId: string, note: string): Promise<Reply>;
}

/** Tasks the fixer for a case. check() runs before any state change (D17 base check). */
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
  /** Admission inputs: own id, exact fixer/verifier ids, the gate mention and both rooms (D26). */
  readonly admission: AdmissionPolicy;
  readonly repo: string;
  readonly quorum: number;
  readonly requiredChecks: readonly string[];
  readonly privileged: PrivilegedHandlers;
  readonly handoff: FixerHandoff;
  readonly agents: AgentInbox;
  /** D26: public intake reports accepted per sender per hour. */
  readonly intakeMaxReportsPerHour: number;
  readonly now: () => Date;
  readonly log?: { error(o: object, m: string): void };
}

/** kv key marking a public report whose maintainer notice is "pending" or "sent". */
const triageNoticeKey = (caseId: string): string => `triage_notice:${caseId}`;

function triageNotice(c: CaseRecord): string {
  return [
    `[${c.id}] Public report awaiting triage (${c.reportText.length} chars, shown in full; untrusted, from the intake room): «${safe(c.reportText, INTAKE_MAX_REPORT_CHARS)}»`,
    `accept ${c.id} — task the fixer · decline ${c.id} <reason>`,
  ].join("\n");
}

/** Coarse, public view of a case state for its own reporter in the intake room. */
function publicState(c: CaseRecord): string {
  if (c.state === "Reported") return "awaiting maintainer triage";
  if (c.state === "Blocked" && c.blockedReason === "TRIAGE_DECLINED") return "declined";
  if (c.state === "Merged") return "fixed and merged";
  if (c.state === "Blocked") return "on hold";
  return "in progress";
}

export class Router {
  /** Recently audited (code, sender) refusals: when, and how many were suppressed since. Bounded. */
  private readonly recentRefusals = new Map<string, { at: number; suppressed: number; sender: string; code: ReasonCode }>();
  /** Visible refusals per (room, sender) in the current window (D27). Bounded. */
  private readonly visibleRefusals = new Map<string, { windowStart: number; count: number }>();
  /** Cases whose triage notice is being posted right now. */
  private readonly noticesInFlight = new Set<string>();

  constructor(private readonly d: RouterDeps) {
    // Fail at construction (startup), not on every message.
    assertAdmissionPolicy(d.admission);
  }

  /**
   * Handle one inbound message. Redelivered events are no-ops. Every message passes
   * admission first: only an addressed report from the exact fixer/verifier id in the
   * maintainers' room reaches the agent inbox, and only an addressed message from a
   * person reaches the parser, together with the room it arrived in.
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
    const room = admission.room;
    const role = roleOf(msg.sender, this.d.identity);
    const trusted = room === "maintainers" && role === "maintainer";

    const parsed = parseCommand(msg.body, this.d.admission.gateMention);
    if (!parsed.ok) {
      const usage = usageFor(availableCommands(room, role, this.d.identity));
      const detail = trusted ? `${parsed.error}. Usage:\n${usage}` : null;
      await this.refuseVisible(msg, null, "UNKNOWN_COMMAND", detail === null ? {} : { detail }, "unknown", trusted, usage);
      return;
    }

    const command = parsed.command;
    const decision = authorize(command.kind, role, room, this.d.identity);
    if (!decision.ok) {
      const caseId = "caseId" in command ? command.caseId : null;
      await this.refuseVisible(msg, caseId, decision.code, { command: command.kind, sender: msg.sender, ...(caseId !== null ? { caseId } : {}) }, command.kind, trusted, null);
      return;
    }

    let reply: Reply | null;
    try {
      reply = await this.dispatch(command, { msg, role, room });
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

  private async dispatch(command: Command, ctx: CommandContext): Promise<Reply | null> {
    switch (command.kind) {
      case "help": {
        const usage = usageFor(availableCommands(ctx.room, ctx.role, this.d.identity));
        return ctx.room === "intake"
          ? { text: `Loopback bug intake. Commands here:\n${usage}`, caseId: null }
          : { text: `Loopback commands (your role: ${ctx.role}):\n${usage}`, caseId: null };
      }
      case "whoami":
        return { text: `Your participant id: ${safe(ctx.msg.sender)} · role: ${ctx.role}`, caseId: null };
      case "report":
        return ctx.room === "intake" ? this.intakeReport(ctx.msg, command.text) : this.report(ctx.msg, command.text);
      case "status":
        return ctx.room === "intake" ? this.intakeStatus(ctx.msg, command.caseId) : this.status(command.caseId);
      case "audit":
        return this.audit(command.caseId);
      case "accept":
        return this.accept(ctx.msg, command.caseId);
      case "decline":
        return this.decline(ctx.msg, command.caseId, command.reason);
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

  // --- reports and triage ------------------------------------------------------------------

  /** Maintainers' room: a report from a maintainer or listed reporter tasks the fixer directly. */
  private async report(msg: InboundMessage, text: string): Promise<Reply | null> {
    const created = createCase(this.d.db, {
      reporterId: msg.sender, roomId: msg.roomId, threadId: msg.threadId, repo: this.d.repo,
      reportText: text, sourceEventId: msg.eventId,
    }, this.d.now());
    if (!created) return null; // duplicate delivery of the same report
    return this.taskFixer(created, "system", false);
  }

  /**
   * Intake room (D26): anyone Switch admits may report. The case is filed in the
   * maintainers' room and waits in Reported for triage; nothing tasks the fixer here.
   * The report text is untrusted and is only ever shown escaped.
   */
  private async intakeReport(msg: InboundMessage, raw: string): Promise<Reply | null> {
    const { db, now } = this.d;
    const t = now().getTime();
    const text = raw.replace(INVISIBLE, "");
    if (text.length > INTAKE_MAX_REPORT_CHARS) {
      await this.refuseVisible(msg, null, "REPORT_TOO_LONG", { detail: String(INTAKE_MAX_REPORT_CHARS) }, "report", false, null, true);
      return null;
    }
    const duplicate = findRecentReport(db, msg.sender, text, new Date(t - DUPLICATE_REPORT_WINDOW_MS).toISOString());
    if (duplicate) {
      // Through the D27 path: audit throttle and visible-refusal limit apply to repeats too.
      await this.refuseVisible(msg, null, "DUPLICATE_REPORT", { caseId: duplicate.id }, "report", false, null, true);
      return null;
    }
    if (countReportsSince(db, msg.sender, new Date(t - 60 * 60_000).toISOString()) >= this.d.intakeMaxReportsPerHour) {
      await this.refuseVisible(msg, null, "INTAKE_RATE_LIMITED", {}, "report", false, null, true);
      return null;
    }
    const pending = (db.prepare("SELECT count(*) AS n FROM kv WHERE k LIKE 'triage_notice:%' AND k IN (SELECT 'triage_notice:' || id FROM cases WHERE state = 'Reported')").get() as { n: number }).n;
    if (pending >= INTAKE_MAX_PENDING) {
      await this.refuseVisible(msg, null, "INTAKE_BUSY", {}, "report", false, null, true);
      return null;
    }
    const created = createCase(db, {
      reporterId: msg.sender, roomId: this.d.admission.maintainerRoomId, threadId: null, repo: this.d.repo,
      reportText: text, sourceEventId: msg.eventId,
    }, now());
    if (!created) return null;
    // Marked pending before posting (no await in between): if the post fails, the periodic
    // announcePendingTriage() re-sends it, so a filed report always reaches maintainers.
    kvSet(db, triageNoticeKey(created.id), "pending");
    await this.sendTriageNotice(created);
    return { text: `Thanks — received as ${created.id}. A maintainer will review it before any work starts.`, caseId: null };
  }

  /** Post the triage notice for a public case; on failure leave it pending and log. */
  private async sendTriageNotice(c: CaseRecord): Promise<boolean> {
    // One send at a time per case: the periodic re-send never races the first attempt.
    if (this.noticesInFlight.has(c.id)) return false;
    this.noticesInFlight.add(c.id);
    try {
      await this.d.chat.post(c.roomId, triageNotice(c), null);
    } catch (e) {
      this.d.log?.error({ caseId: c.id, op: "triage.notice", err: e instanceof Error ? e.name : "unknown" }, "could not post the triage notice; will retry");
      return false;
    } finally {
      this.noticesInFlight.delete(c.id);
    }
    kvSet(this.d.db, triageNoticeKey(c.id), "sent");
    return true;
  }

  /**
   * Re-send triage notices that could not be posted (called at startup and periodically).
   * Cases no longer awaiting triage are simply marked done.
   */
  async announcePendingTriage(): Promise<void> {
    const keys = this.d.db.prepare("SELECT k FROM kv WHERE k LIKE 'triage_notice:%' AND v = 'pending'").all() as { k: string }[];
    for (const { k } of keys) {
      const c = getCase(this.d.db, k.slice("triage_notice:".length));
      if (c?.state !== "Reported") {
        kvSet(this.d.db, k, "sent");
        continue;
      }
      await this.sendTriageNotice(c);
    }
  }

  /** Intake room: a reporter sees only the coarse state of their own reports. */
  private intakeStatus(msg: InboundMessage, caseId: string): Reply {
    const c = getCase(this.d.db, caseId);
    // Someone else's case reads exactly like a missing one: no existence oracle.
    if (!c || c.reporterId !== msg.sender) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    return { text: `${c.id} · ${publicState(c)}`, caseId: null };
  }

  /** Maintainer triage: accept a public report and task the fixer (Reported → Triaged → FixInProgress). */
  private async accept(msg: InboundMessage, caseId: string): Promise<Reply> {
    const c = getCase(this.d.db, caseId);
    if (!c) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    if (c.state !== "Reported") return { text: formatReason("INVALID_STATE", { command: "accept", caseId, state: c.state }), caseId };
    const reply = await this.taskFixer(c, msg.sender, true);
    return reply ?? { text: formatReason("INVALID_STATE", { command: "accept", caseId, state: getCase(this.d.db, caseId)?.state ?? "unknown" }), caseId };
  }

  /** Maintainer triage: decline a public report (Reported → Blocked, terminal TRIAGE_DECLINED). */
  private decline(msg: InboundMessage, caseId: string, reason: string): Reply {
    const { db, now } = this.d;
    const c = getCase(db, caseId);
    if (!c) return { text: formatReason("CASE_NOT_FOUND", { caseId }), caseId: null };
    const done = db.transaction(() => {
      const fresh = getCase(db, caseId);
      if (fresh?.state !== "Reported") return false;
      append(db, { caseId, actorId: msg.sender, type: "case.triaged", reasonCode: "TRIAGE_DECLINED", payload: { decision: "decline", reason } }, now());
      transitionInTx(db, { caseId, to: "Blocked", actorId: msg.sender, trigger: "command", reason: "TRIAGE_DECLINED" }, now());
      return true;
    })();
    if (!done) return { text: formatReason("INVALID_STATE", { command: "decline", caseId, state: getCase(db, caseId)?.state ?? c.state }), caseId };
    return { text: `${caseId} declined during triage. The fixer was not tasked.`, caseId };
  }

  /**
   * Task the fixer for a Reported case. The state is re-read inside the transaction, so a
   * repeated accept (or an accept racing a decline) tasks the fixer at most once.
   * Returns null when the case is no longer Reported.
   */
  private async taskFixer(c: CaseRecord, actorId: string, triage: boolean): Promise<Reply | null> {
    const { db, now } = this.d;
    const problem = await this.d.handoff.check(c);
    const trigger = triage ? "command" : "system";
    if (problem !== null) {
      const blocked = db.transaction(() => {
        if (getCase(db, c.id)?.state !== "Reported") return false;
        transitionInTx(db, { caseId: c.id, to: "Blocked", actorId, trigger, reason: problem }, now());
        return true;
      })();
      return blocked ? { text: formatReason(problem, { caseId: c.id }), caseId: c.id } : null;
    }
    const tasked = db.transaction(() => {
      const fresh = getCase(db, c.id);
      if (fresh?.state !== ("Reported" satisfies CaseState)) return null;
      if (triage) append(db, { caseId: c.id, actorId, type: "case.triaged", payload: { decision: "accept" } }, now());
      transitionInTx(db, { caseId: c.id, to: "Triaged", actorId, trigger, reason: null }, now());
      return transitionInTx(db, { caseId: c.id, to: "FixInProgress", actorId, trigger, reason: null, auditType: "fixer.started" }, now());
    })();
    if (tasked === null) return null;
    // Persisted first, announced second (invariant 10).
    await this.d.chat.post(tasked.roomId, this.d.handoff.message(tasked), tasked.threadId);
    return { text: `${tasked.id} ${triage ? "accepted" : "created"} · state Triaged → FixInProgress · tasked the fixer`, caseId: tasked.id };
  }

  // --- read-only views ---------------------------------------------------------------------

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

  // --- refusals -------------------------------------------------------------------------------

  /**
   * D27 visible refusal of an addressed message. Maintainers in their own room get the
   * precise reason; everyone else gets the generic refusal (plus, for an unknown command,
   * the commands they can actually use), rate-limited per room and sender.
   */
  private async refuseVisible(
    msg: InboundMessage,
    caseId: string | null,
    code: ReasonCode,
    ctx: Parameters<typeof formatReason>[1],
    command: string,
    trusted: boolean,
    usage: string | null,
    specific = false,
  ): Promise<void> {
    if (trusted) {
      await this.refuse(msg, caseId, code, ctx, command);
      return;
    }
    const audit = this.shouldAuditRefusal(msg.sender, code);
    const reply = this.allowVisibleRefusal(msg.roomId, msg.sender);
    const text = specific ? formatReason(code, ctx) : usage !== null && usage !== "" ? `${GENERIC_REFUSAL}\nCommands available to you here:\n${usage}` : GENERIC_REFUSAL;
    if (audit) {
      await this.refuse(msg, caseId, code, ctx, command, { reply: false, payload: { visible: reply } });
    } else {
      markProcessed(this.d.db, msg.eventId, this.d.now());
    }
    if (reply) await this.post(msg, { text, caseId: null });
  }

  /** At most VISIBLE_REFUSALS_PER_WINDOW visible refusals per (room, sender); a full table stays silent. */
  private allowVisibleRefusal(roomId: string, sender: string): boolean {
    const t = this.d.now().getTime();
    const key = `${roomId}\u0000${sender}`;
    const entry = this.visibleRefusals.get(key);
    if (entry !== undefined && t - entry.windowStart < VISIBLE_REFUSAL_WINDOW_MS) {
      if (entry.count >= VISIBLE_REFUSALS_PER_WINDOW) return false;
      entry.count += 1;
      return true;
    }
    if (entry === undefined && this.visibleRefusals.size >= VISIBLE_REFUSAL_MAX_KEYS) {
      for (const [k, v] of this.visibleRefusals) if (t - v.windowStart >= VISIBLE_REFUSAL_WINDOW_MS) this.visibleRefusals.delete(k);
      if (this.visibleRefusals.size >= VISIBLE_REFUSAL_MAX_KEYS) return false;
    }
    this.visibleRefusals.set(key, { windowStart: t, count: 1 });
    return true;
  }

  /**
   * Whether to write an audit row for this refusal. Throttled refusals are counted and
   * reported in a summary row when their window closes. Fails toward auditing: when the
   * tracking table is full of live entries, the refusal is audited.
   */
  private shouldAuditRefusal(sender: string, code: ReasonCode): boolean {
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

  /** Record and (optionally) announce a refusal. Every recorded refusal is audited (invariant 9). */
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
