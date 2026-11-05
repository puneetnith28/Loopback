import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly iconAfter?: IconName;
  /** Shows a quiet progress indicator, keeps the label for screen readers and blocks repeat clicks. */
  readonly busy?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function Button({ variant = "secondary", size = "md", icon, iconAfter, busy = false, disabled, type = "button", className, children, ...rest }: ButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], size !== "md" && styles[size], className)}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className={styles.busy} aria-hidden="true"><span /><span /><span /></span> : icon ? <Icon name={icon} size={iconSize} /> : null}
      <span>{children}</span>
      {iconAfter && !busy ? <Icon name={iconAfter} size={iconSize} /> : null}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  readonly icon: IconName;
  /** Required: an icon-only control must have an accessible name (WCAG 4.1.2). */
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function IconButton({ icon, label, variant = "ghost", size = "md", type = "button", className, ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} className={cx(styles.button, styles.icon, styles[variant], size !== "md" && styles[size], className)} {...rest}>
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
  );
}
