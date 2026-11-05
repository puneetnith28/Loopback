import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cx } from "./Button.tsx";
import styles from "./Feedback.module.css";

export type AlertTone = "info" | "success" | "attention" | "danger" | "demo";
const ICON: Readonly<Record<AlertTone, IconName>> = { info: "info", success: "check", attention: "alert-triangle", danger: "alert-circle", demo: "flask" };

/** Danger alerts interrupt (role="alert"); everything else is a polite status. */
export function Alert({ tone = "info", title, children, action }: { readonly tone?: AlertTone; readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className={cx(styles.alert, styles[tone])} role={tone === "danger" ? "alert" : "status"}>
      <span className={styles.alertIcon}><Icon name={ICON[tone]} size={16} /></span>
      <div>
        <p className={styles.alertTitle}>{title}</p>
        {children ? <div className={styles.alertBody}>{children}</div> : null}
      </div>
      {action ?? null}
    </div>
  );
}
