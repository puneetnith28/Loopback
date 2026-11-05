import { useEffect, type ReactNode } from "react";
import type { CaseState } from "@loopback/contracts";
import { Button } from "../../design-system/components/Button.tsx";
import { StatusIndicator, type Status } from "../../design-system/components/Badge.tsx";
import { STATE_LABELS } from "../../lib/lifecycle.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import styles from "./shared.module.css";

export const APP_TITLE = "Loopback Console";

interface PageProps {
  readonly title: string;
  readonly eyebrow?: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Every screen's frame: one h1 (focused after in-app navigation, so screen-reader and keyboard users land on the
 * new page), the document title, and an optional actions slot.
 */
export function Page({ title, eyebrow, description, actions, children }: PageProps) {
  useEffect(() => {
    document.title = `${title} · ${APP_TITLE}`;
  }, [title]);
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.pageTitles}>
          {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
          <h1 className={styles.title} tabIndex={-1} data-page-heading>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.pageActions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** "Generated 2 minutes ago" from the API's own generatedAt, plus a manual refresh. */
export function Freshness({ generatedAt, fetching, onRefresh }: { readonly generatedAt: string; readonly fetching: boolean; readonly onRefresh: () => void }) {
  return (
    <p className={styles.freshness}>
      <span>
        Read API data generated <time dateTime={generatedAt} title={absoluteTime(generatedAt)}>{relativeTime(generatedAt)}</time>
      </span>
      <Button size="sm" variant="ghost" icon="refresh" busy={fetching} onClick={onRefresh}>
        {fetching ? "Refreshing" : "Refresh"}
      </Button>
    </p>
  );
}

const STATE_STATUS: Readonly<Record<CaseState, Status>> = {
  Reported: "pending", Triaged: "pending", FixInProgress: "running", PRCreated: "running", Verifying: "running",
  VerificationFailed: "failed", AwaitingApproval: "awaiting-human", ReadyToMerge: "awaiting-human",
  Revalidating: "running", Merging: "running", Merged: "verified", Stale: "pending", Blocked: "blocked", MergeUnknown: "unknown",
};

/** The gate's state for a case, shown as icon + text. Display only: the gate decides the state. */
export function CaseStateIndicator({ state, detail }: { readonly state: CaseState; readonly detail?: string }) {
  return <StatusIndicator status={STATE_STATUS[state]} label={STATE_LABELS[state]} {...(detail ? { detail } : {})} />;
}

interface LoadMoreProps {
  readonly shown: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
  readonly noun: string;
}

/** Cursor pagination control with a polite count announcement. */
export function LoadMore({ shown, hasMore, loading, onLoadMore, noun }: LoadMoreProps) {
  return (
    <div className={styles.loadMore}>
      <p role="status" className={styles.count}>Showing {shown} {noun}{hasMore ? "" : " (all loaded)"}</p>
      {hasMore ? (
        <Button size="sm" icon="chevron-down" busy={loading} onClick={onLoadMore}>
          {loading ? "Loading" : `Load more ${noun}`}
        </Button>
      ) : null}
    </div>
  );
}
