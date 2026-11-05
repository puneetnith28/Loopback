import type { Provenance } from "../../lib/provenance.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { ProvenanceStamp } from "./ProvenanceStamp.tsx";
import { UntrustedText } from "./UntrustedText.tsx";
import { cx } from "./Button.tsx";
import styles from "./Timeline.module.css";

export const EVENT_KINDS = ["human", "machine", "gate", "github", "verification", "failure", "rejection"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const KIND: Readonly<Record<EventKind, { icon: IconName; label: string }>> = {
  human: { icon: "user", label: "Human action" },
  machine: { icon: "cpu", label: "Machine action" },
  gate: { icon: "shield", label: "Gate decision" },
  github: { icon: "pull-request", label: "GitHub event" },
  verification: { icon: "seal", label: "Verification" },
  failure: { icon: "x", label: "Failure" },
  rejection: { icon: "alert-triangle", label: "Rejection" },
};

export interface TimelineEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly actor: string;
  /** ISO 8601 timestamp. */
  readonly at: string;
  readonly provenance: Provenance;
  /** Untrusted free text (agent output, reason, payload excerpt): rendered as plain text only. */
  readonly detail?: string;
}

/** Chronological event list. Renders only what it is given; it never synthesises events. */
export function Timeline({ events, now }: { readonly events: readonly TimelineEvent[]; readonly now?: Date }) {
  return (
    <ol className={styles.timeline}>
      {events.map((e) => {
        const k = KIND[e.kind];
        return (
          <li key={e.id} className={cx(styles.event, styles[e.kind])} data-kind={e.kind}>
            <span className={styles.marker}><Icon name={k.icon} size={15} label={k.label} /></span>
            <div className={styles.content}>
              <div className={styles.head}>
                <span className={styles.title}>{e.title}</span>
                <ProvenanceStamp source={e.provenance} compact />
              </div>
              <div className={styles.meta}>
                <span className={styles.actor}>{e.actor}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={e.at} title={absoluteTime(e.at)} className="numeric">{relativeTime(e.at, now)}</time>
              </div>
              {e.detail ? <div className={styles.detail}><UntrustedText value={e.detail} maxLength={600} /></div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
