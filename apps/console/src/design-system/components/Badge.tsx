import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cx } from "./Button.tsx";
import styles from "./Badge.module.css";

export type Tone = "neutral" | "machine" | "human" | "success" | "danger" | "demo";

export function Badge({ tone = "neutral", icon, wrap = false, children }: { readonly tone?: Tone; readonly icon?: IconName; /** For sentence-length text: wraps instead of widening its container. */ readonly wrap?: boolean; readonly children: ReactNode }) {
  return (
    <span className={cx(styles.badge, styles[tone], wrap && styles.wrap)}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export type Status = "verified" | "failed" | "blocked" | "running" | "awaiting-human" | "pending" | "unknown";

const STATUS: Readonly<Record<Status, { label: string; icon: IconName; tone: Tone }>> = {
  verified: { label: "Verified", icon: "check", tone: "success" },
  failed: { label: "Failed", icon: "x", tone: "danger" },
  blocked: { label: "Blocked", icon: "alert-triangle", tone: "danger" },
  running: { label: "Running", icon: "cpu", tone: "machine" },
  "awaiting-human": { label: "Awaiting maintainer", icon: "user", tone: "human" },
  pending: { label: "Pending", icon: "pending", tone: "neutral" },
  unknown: { label: "Unknown", icon: "alert-circle", tone: "neutral" },
};

/** Status = icon + text (+ colour as a third, redundant cue). Never colour alone (WCAG 1.4.1). */
export function StatusIndicator({ status, detail, label }: { readonly status: Status; readonly detail?: string; readonly label?: string }) {
  const s = STATUS[status];
  return (
    <span className={cx(styles.status, styles[s.tone])}>
      <Icon name={s.icon} size={15} />
      <span>{label ?? s.label}</span>
      {detail ? <span className={styles.statusDetail}>· {detail}</span> : null}
    </span>
  );
}
