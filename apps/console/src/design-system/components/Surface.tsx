import { useId, type ReactNode } from "react";
import { cx } from "./Button.tsx";
import styles from "./Surface.module.css";

interface SurfaceProps {
  readonly as?: "section" | "div" | "article" | "aside";
  readonly tone?: "surface" | "raised" | "inset";
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly "aria-labelledby"?: string;
}

/** A plain layered surface. Never nest Surfaces inside Surfaces (no cards in cards). */
export function Surface({ as: Tag = "div", tone = "surface", className, children, ...rest }: SurfaceProps) {
  return <Tag className={cx(styles.surface, tone !== "surface" && styles[tone], className)} {...rest}>{children}</Tag>;
}

interface CardProps {
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly eyebrow?: string;
  readonly actions?: ReactNode;
  readonly flush?: boolean;
  /** Heading level for the title, so a card fits the page outline (h2 directly under a page h1). */
  readonly level?: 2 | 3;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/** A titled Surface (section + heading). */
export function Card({ title, titleId, eyebrow, actions, flush = false, level = 3, className, children }: CardProps) {
  const Heading = level === 2 ? "h2" : "h3";
  const autoId = useId();
  const headingId = titleId ?? autoId;
  return (
    <section className={cx(styles.surface, className)} aria-labelledby={headingId}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
          <Heading className={styles.title} id={headingId}>{title}</Heading>
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div className={flush ? styles.flush : styles.body}>{children}</div>
    </section>
  );
}
