import type { ReactNode } from "react";
import type { Loadable } from "../../lib/loadable.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { Button, cx } from "./Button.tsx";
import styles from "./Feedback.module.css";

interface StateProps {
  readonly icon: IconName;
  readonly tone?: "neutral" | "danger" | "attention";
  readonly title: string;
  readonly detail: ReactNode;
  readonly action?: ReactNode;
  readonly centered?: boolean;
  readonly role?: "status" | "alert";
}

export function StateMessage({ icon, tone = "neutral", title, detail, action, centered = false, role = "status" }: StateProps): ReactNode {
  return (
    <div className={cx(styles.state, styles[tone], centered && styles.stateCentered)} role={role}>
      <span className={styles.stateIcon}><Icon name={icon} size={18} /></span>
      <p className={styles.stateTitle}>{title}</p>
      <p className={styles.stateDetail}>{detail}</p>
      {action ? <div className={styles.stateActions}>{action}</div> : null}
    </div>
  );
}

interface DataViewProps<T> {
  readonly state: Loadable<T>;
  /** Rendered for success and partial. */
  readonly children: (data: T) => ReactNode;
  /** Skeleton matching the final layout. */
  readonly skeleton: ReactNode;
  readonly label: string;
}

/** The six content states, rendered by one exhaustive switch (DESIGN.md §4). */
function assertNever(value: never): never {
  throw new Error(`Unhandled content state: ${JSON.stringify(value)}`);
}

export function DataView<T>({ state, children, skeleton, label }: DataViewProps<T>): ReactNode {
  switch (state.status) {
    case "loading":
      // Live regions announce content, not labels: the status text is real (visually hidden) content.
      return (
        <div role="status">
          <span className="visually-hidden">Loading {label}…</span>
          <div aria-hidden="true">{skeleton}</div>
        </div>
      );
    case "empty":
      return <StateMessage icon="layers" title={state.title} detail={state.detail} />;
    case "error":
      return (
        <StateMessage
          icon="alert-circle" tone="danger" role="alert" title={state.title} detail={state.detail}
          action={state.retry ? <Button size="sm" icon="refresh" onClick={state.retry}>Try again</Button> : undefined}
        />
      );
    case "permission":
      return <StateMessage icon="lock" tone="attention" title={`No access: ${state.boundary}`} detail={state.detail} />;
    case "partial":
      return (
        <div>
          <p className={styles.partial} role="status">
            <Icon name="alert-triangle" size={14} />
            <span>Partial data — unavailable: {state.missing.join(", ")}.</span>
            {state.retry ? <Button size="sm" variant="ghost" icon="refresh" onClick={state.retry}>Retry</Button> : null}
          </p>
          {children(state.data)}
        </div>
      );
    case "success":
      return <>{children(state.data)}</>;
    default:
      return assertNever(state);
  }
}
