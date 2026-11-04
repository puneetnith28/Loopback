import { namesGate } from "../policy/admission.js";
import type { ContextRead } from "./ops.js";

/**
 * Recovery after Switch reports a delivery gap (step 3.9, §15.1).
 *
 * `read_context` entries carry no `addressed` flag, so a recovered message cannot pass
 * admission and is **never executed**. Recovery instead makes the loss visible and safe:
 * every unprocessed message aimed at the gate is recorded in the audit log, maintainers
 * are told how many to resend (no untrusted content is echoed), and open cases and
 * interrupted merges are reconciled against GitHub (step 8.9).
 */

export interface GapDeps {
  readonly readContext: (roomId: string) => Promise<ContextRead>;
  readonly isProcessed: (eventId: string) => boolean;
  readonly gateMention: string;
  /** Exact fixer and verifier participant ids: their messages are always aimed at the gate. */
  readonly agentIds: ReadonlySet<string>;
  readonly selfId: string;
  /** Append the `delivery.gap` audit event. */
  readonly record: (roomId: string, payload: Readonly<Record<string, unknown>>) => void;
  /** Tell the maintainers (their room only); never called with message content. */
  readonly notifyMaintainers: (text: string) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  readonly log: { error(o: object, m: string): void };
}

export interface GapOutcome {
  readonly read: boolean;
  readonly missed: number;
  readonly truncated: boolean;
}

export async function recoverGap(roomId: string, reason: string, d: GapDeps): Promise<GapOutcome> {
  const ctx = await d.readContext(roomId);
  let outcome: GapOutcome;
  if (!ctx.ok) {
    d.record(roomId, { reason, recovered: false, error: ctx.reason });
    outcome = { read: false, missed: 0, truncated: false };
    await d.notifyMaintainers(`Switch reported undelivered messages and the room history could not be read. Re-send any command from the last few minutes.`);
  } else {
    const missed = ctx.entries.filter((e) =>
      e.sender !== d.selfId && !d.isProcessed(e.id) && (d.agentIds.has(e.sender) || namesGate(e.body, d.gateMention)));
    d.record(roomId, {
      reason, recovered: true, truncated: ctx.truncated,
      missed: missed.map((e) => ({ messageId: e.id, sender: e.sender, timestamp: e.timestamp })),
    });
    outcome = { read: true, missed: missed.length, truncated: ctx.truncated };
    if (missed.length > 0 || ctx.truncated) {
      await d.notifyMaintainers(
        `Switch reported undelivered messages: ${missed.length} message(s) addressed to the gate were not processed${ctx.truncated ? " (history truncated; there may be more)" : ""}. ` +
        "They were not executed. Re-send any command that got no reply.",
      );
    }
  }
  try {
    await d.reconcile();
  } catch (e) {
    d.log.error({ op: "gap.reconcile", err: e instanceof Error ? e.name : "unknown" }, "reconciliation after a delivery gap failed; the periodic task will retry");
  }
  return outcome;
}
