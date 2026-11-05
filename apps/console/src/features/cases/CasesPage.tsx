import { CASE_STATES, type CaseState } from "@loopback/contracts";
import { fromInfiniteQuery } from "../../api/loadable.ts";
import { useCaseList } from "../../api/queries.ts";
import type { CaseSummary } from "../../api/schemas.ts";
import { Link, hrefFor, navigate } from "../../app/router.tsx";
import { DataTable } from "../../design-system/components/DataTable.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { Select } from "../../design-system/components/Select.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Surface } from "../../design-system/components/Surface.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { STATE_LABELS, isKnownState } from "../../lib/lifecycle.ts";
import { reasonLabel } from "../../lib/labels.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { CaseStateIndicator, Freshness, LoadMore, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";

const ALL = "all";
const STATE_OPTIONS = [{ value: ALL, label: "All states" }, ...CASE_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] }))];

export function CasesPage({ state }: { readonly state: CaseState | null }) {
  const query = useCaseList(state);
  const loadable = fromInfiniteQuery(query, {
    resource: "cases",
    isEmpty: (cases) => cases.length === 0,
    empty: state
      ? { title: `No cases in “${STATE_LABELS[state]}”`, detail: "Choose another state, or all states." }
      : { title: "No cases yet", detail: "Cases appear after a reporter files one in the intake room." },
  });
  return (
    <Page title="Cases" eyebrow="Case management" description="Every case the gate is tracking, newest activity first. Open a case for its evidence.">
      <div className={shared.toolbar}>
        <Select
          label="Filter by state" options={STATE_OPTIONS} value={state ?? ALL}
          onChange={(e) => {
            const value = e.target.value;
            navigate(hrefFor({ name: "cases", state: isKnownState(value) ? value : null }));
          }}
        />
      </div>
      <DataView state={loadable} label="cases" skeleton={<ListSkeleton />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />
            <Surface>
              <CaseTable cases={value} caption={state ? `Cases in ${STATE_LABELS[state]}` : "All cases"} />
              <LoadMore shown={value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="cases" />
            </Surface>
          </>
        )}
      </DataView>
    </Page>
  );
}

export function CaseTable({ cases, caption }: { readonly cases: readonly CaseSummary[]; readonly caption: string }) {
  return (
    <DataTable
      caption={caption} captionHidden rows={cases} rowKey={(c) => c.id}
      columns={[
        { key: "id", header: "Case", sortValue: (c) => c.id, render: (c) => <Link className={shared.mono} to={{ name: "case", id: c.id }}>{c.id}</Link> },
        {
          key: "state", header: "State", sortValue: (c) => STATE_LABELS[c.state],
          render: (c) => <CaseStateIndicator state={c.state} {...(c.blockedReason ? { detail: reasonLabel(c.blockedReason) } : {})} />,
        },
        { key: "report", header: "Report (untrusted)", render: (c) => <UntrustedText value={c.reportExcerpt} maxLength={120} /> },
        { key: "pr", header: "Pull request", render: (c) => (c.prNumber ? <span className={shared.mono}>{c.repo}#{c.prNumber}</span> : <span className={shared.muted}>None yet</span>) },
        { key: "head", header: "Head commit", render: (c) => (c.headSha ? <Sha value={c.headSha} copyable={false} /> : <span className={shared.muted}>—</span>) },
        {
          key: "updated", header: "Updated", sortValue: (c) => c.updatedAt,
          render: (c) => <time dateTime={c.updatedAt} title={absoluteTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</time>,
        },
      ]}
    />
  );
}

function ListSkeleton() {
  return (
    <div className={shared.stack}>
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={40} />)}
    </div>
  );
}
