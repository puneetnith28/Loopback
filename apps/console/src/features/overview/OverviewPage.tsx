import type { CaseState } from "@loopback/contracts";
import { fromQuery } from "../../api/loadable.ts";
import { useOverview } from "../../api/queries.ts";
import type { CaseSummary, Overview } from "../../api/schemas.ts";
import { Link } from "../../app/router.tsx";
import { DataTable } from "../../design-system/components/DataTable.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Card } from "../../design-system/components/Surface.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { DETOURS, MAIN_PATH, STATE_LABELS } from "../../lib/lifecycle.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { AuditTimeline } from "../shared/AuditTimeline.tsx";
import { CaseStateIndicator, Freshness, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";
import styles from "./overview.module.css";

const STATE_ORDER: readonly CaseState[] = [...MAIN_PATH, ...DETOURS.map((d) => d.state)];

function totalCases(o: Overview): number {
  return STATE_ORDER.reduce((sum, s) => sum + o.countsByState[s], 0);
}

export function OverviewPage() {
  const query = useOverview();
  const state = fromQuery(query, {
    resource: "the overview",
    isEmpty: (o) => totalCases(o) === 0 && o.recentActivity.length === 0,
    empty: { title: "No cases yet", detail: "The gate has not recorded any reports. Cases appear here after a reporter files one in the intake room." },
  });
  return (
    <Page title="Overview" eyebrow="Loopback" description="What the gate has recorded, and which cases are waiting on a maintainer. Counts are computed by the read API, not in the browser.">
      <DataView state={state} label="overview" skeleton={<OverviewSkeleton />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching} onRefresh={() => { void query.refetch(); }} />
            {/* Scan order (DESIGN.md §1): what needs a human first, then the distribution of states. */}
            <div className={shared.grid2}>
              <AttentionCard cases={value.attention} />
              <VerificationCard overview={value} />
            </div>
            <StateCounts overview={value} />
            <Card level={2} title="Recent activity" eyebrow="Audit log" actions={<Link to={{ name: "audit", caseId: null, type: null }}>Full audit history</Link>}>
              {value.recentActivity.length > 0 ? <AuditTimeline events={value.recentActivity} /> : <p className={shared.muted}>No recorded activity yet.</p>}
            </Card>
          </>
        )}
      </DataView>
    </Page>
  );
}

function StateCounts({ overview }: { readonly overview: Overview }) {
  return (
    <section aria-labelledby="counts-title" className={styles.counts}>
      <div className={styles.countsHead}>
        <h2 id="counts-title" className={styles.sectionTitle}>Cases by state</h2>
        <ProvenanceStamp source="gate" compact />
      </div>
      <ul className={styles.tiles}>
        {STATE_ORDER.map((s) => (
          <li key={s}>
            <Link className={styles.tile} to={{ name: "cases", state: s }} data-empty={overview.countsByState[s] === 0}>
              <span className={styles.tileCount}>{overview.countsByState[s]}</span>
              <span className={styles.tileLabel}>{STATE_LABELS[s]}<span className="visually-hidden"> cases</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionCard({ cases }: { readonly cases: readonly CaseSummary[] }) {
  return (
    <Card level={2} title="Waiting on a maintainer" eyebrow="Selected by the gate" flush>
      {cases.length === 0 ? (
        <p className={styles.pad}>No case is waiting on a maintainer.</p>
      ) : (
        <DataTable
          caption="Cases waiting on a maintainer" captionHidden rows={cases} rowKey={(c) => c.id}
          columns={[
            { key: "id", header: "Case", render: (c) => <Link className={shared.mono} to={{ name: "case", id: c.id }}>{c.id}</Link> },
            { key: "state", header: "State", render: (c) => <CaseStateIndicator state={c.state} /> },
            { key: "report", header: "Report", render: (c) => <UntrustedText value={c.reportExcerpt} maxLength={90} /> },
            { key: "head", header: "Head", render: (c) => (c.headSha ? <Sha value={c.headSha} copyable={false} /> : <span className={shared.muted}>No PR yet</span>) },
            { key: "updated", header: "Updated", render: (c) => <time dateTime={c.updatedAt} title={absoluteTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</time> },
          ]}
        />
      )}
    </Card>
  );
}

function VerificationCard({ overview }: { readonly overview: Overview }) {
  const v = overview.verification;
  const rows: readonly (readonly [string, number])[] = [
    ["Passed", v.pass], ["Failed", v.fail], ["Invalid report", v.invalid], ["Timed out", v.timeout], ["Still running", v.requested], ["Superseded", v.superseded],
  ];
  return (
    <Card level={2} title={`Verification runs, last ${v.windowDays} days`} eyebrow="Recorded by the gate" actions={<ProvenanceStamp source="gate" compact />}>
      <dl className={shared.dl}>
        {rows.map(([label, n]) => (
          <div key={label} className={styles.dlRow}>
            <dt>{label}</dt>
            <dd className="numeric">{n}</dd>
          </div>
        ))}
      </dl>
      <p className={shared.muted}>Each run's signature and mode are on the <Link to={{ name: "gate" }}>Gate &amp; verification</Link> page.</p>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className={shared.stack}>
      <Skeleton height={14} width="40%" />
      <div className={styles.tiles}>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={64} />)}</div>
      <Skeleton height={180} />
    </div>
  );
}
