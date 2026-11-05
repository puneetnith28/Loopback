import type { AuditEvent } from "../../api/schemas.ts";
import { Timeline, type TimelineEvent } from "../../design-system/components/Timeline.tsx";
import { eventKind, eventLabel, reasonLabel } from "../../lib/labels.ts";
import { revealHidden } from "../../lib/untrusted.ts";
import { shortSha } from "../../lib/format.ts";

const MAX_VALUE = 160;

function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** Redacted payload as "key: value" plain text. Never parsed as markup; hidden characters are revealed downstream. */
export function formatPayload(payload: Readonly<Record<string, unknown>>): string {
  return Object.entries(payload).map(([k, v]) => `${k}: ${show(v)}`).join(" · ");
}

export function toTimelineEvent(e: AuditEvent): TimelineEvent {
  const parts = [
    e.reasonCode ? `${reasonLabel(e.reasonCode)} (${e.reasonCode})` : null,
    e.targetSha ? `commit ${shortSha(e.targetSha)}` : null,
    Object.keys(e.payload).length > 0 ? formatPayload(e.payload) : null,
  ].filter((p): p is string => p !== null);
  return {
    id: String(e.id),
    kind: eventKind(e.eventType),
    title: e.caseId ? `${eventLabel(e.eventType)} · ${e.caseId}` : eventLabel(e.eventType),
    actor: revealHidden(e.actorId, 256).text,
    at: e.createdAt,
    provenance: e.provenance,
    ...(parts.length > 0 ? { detail: parts.join(" — ") } : {}),
  };
}

/** Audit events exactly as the API returned them (newest first is the API's order; nothing is synthesised). */
export function AuditTimeline({ events }: { readonly events: readonly AuditEvent[] }) {
  return <Timeline events={events.map(toTimelineEvent)} />;
}
