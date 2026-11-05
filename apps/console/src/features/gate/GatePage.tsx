import { fromInfiniteQuery, fromQuery } from "../../api/loadable.ts";
import { useAuditFeed, useConfigSummary, useVerificationRuns } from "../../api/queries.ts";
import type { ConfigSummary, VerificationRunListItem } from "../../api/schemas.ts";
import { Link } from "../../app/router.tsx";
import { Alert } from "../../design-system/components/Alert.tsx";
import { Badge, StatusIndicator } from "../../design-system/components/Badge.tsx";
import { DataTable } from "../../design-system/components/DataTable.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Card, Surface } from "../../design-system/components/Surface.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { GATE_EVENT_TYPES } from "../../lib/labels.ts";
import { AppliesTo, RUN_STATUS, SIGNATURE_TEXT } from "../case-detail/EvidenceSections.tsx";
import { AuditTimeline } from "../shared/AuditTimeline.tsx";
import { Freshness, LoadMore, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";

export function GatePage() {
  return (
    <Page title="Gate & verification" eyebrow="Decisions and evidence" description="Every verification run and gate decision the read API reports. The gate alone decides whether a commit may merge.">
      <VerificationModeNotice />
      <VerificationRunsSection />
      <GateDecisionsSection />
    </Page>
  );
}

function ModeAlert({ config }: { readonly config: ConfigSummary }) {
  if (config.verificationMode === "advisory") {
    return (
      <Alert tone="attention" title="Verification is advisory">
        The verifier is not proven isolated, so its reports are not treated as independent evidence even when they pass.
        Runs below are marked “Advisory”.
      </Alert>
    );
  }
  return <Alert tone="info" title="Verification is isolated">Every report must carry a valid verifier signature; unsigned or invalid reports are rejected by the gate.</Alert>;
}

function VerificationModeNotice() {
  const query = useConfigSummary();
  const state = fromQuery(query, { resource: "the verification mode" });
  return (
    <DataView state={state} label="verification mode" skeleton={<Skeleton height={56} />}>
      {({ value }) => <ModeAlert config={value} />}
    </DataView>
  );
}

function RunTable({ runs }: { readonly runs: readonly VerificationRunListItem[] }) {
  return (
    <DataTable
      caption="Verification runs by case" captionHidden rows={runs} rowKey={(r) => r.id}
      columns={[
        { key: "case", header: "Case", sortValue: (r) => r.caseId, render: (r) => <Link className={shared.mono} to={{ name: "case", id: r.caseId }}>{r.caseId}</Link> },
        {
          key: "commit", header: "Commit",
          render: (r) => <span className={shared.inlineList}><Sha value={r.headSha} copyable={false} /><AppliesTo sha={r.headSha} headSha={r.caseHeadSha} /></span>,
        },
        { key: "result", header: "Result", render: (r) => <StatusIndicator status={RUN_STATUS[r.status].status} label={RUN_STATUS[r.status].label} /> },
        { key: "signature", header: "Signature", render: (r) => (r.signature ? SIGNATURE_TEXT[r.signature] : "Not recorded yet") },
        {
          key: "mode", header: "Mode",
          render: (r) => (r.mode === "advisory" ? <Badge tone="human" icon="alert-triangle">Advisory</Badge> : r.mode === "isolated" ? <Badge tone="machine" icon="shield">Isolated</Badge> : "Not recorded"),
        },
        { key: "source", header: "Source", render: (r) => <ProvenanceStamp source={r.provenance} compact /> },
        { key: "requested", header: "Requested", sortValue: (r) => r.requestedAt, render: (r) => <time dateTime={r.requestedAt} title={absoluteTime(r.requestedAt)}>{relativeTime(r.requestedAt)}</time> },
      ]}
    />
  );
}

function VerificationRunsSection() {
  const query = useVerificationRuns();
  const state = fromInfiniteQuery(query, {
    resource: "verification runs", isEmpty: (r) => r.length === 0,
    empty: { title: "No verification runs", detail: "The gate requests verification after the fixer opens a pull request." },
  });
  return (
    <section aria-labelledby="runs-title" className={shared.stack}>
      <h2 id="runs-title" className={shared.sectionTitle}>Verification runs</h2>
      <DataView state={state} label="verification runs" skeleton={<Skeleton height={200} />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />
            <Surface>
              <RunTable runs={value} />
              <LoadMore shown={value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="runs" />
            </Surface>
          </>
        )}
      </DataView>
    </section>
  );
}

function GateDecisionsSection() {
  const query = useAuditFeed({ caseId: null, types: GATE_EVENT_TYPES });
  const state = fromInfiniteQuery(query, {
    resource: "gate decisions", isEmpty: (e) => e.length === 0,
    empty: { title: "No gate decisions yet", detail: "Approvals, refusals and merge decisions appear here once the gate makes them." },
  });
  return (
    <Card level={2} title="Gate decisions" eyebrow="Approvals, refusals and merges" flush>
      <div className={shared.pad}>
        <DataView state={state} label="gate decisions" skeleton={<Skeleton height={160} />}>
          {({ value }) => <AuditTimeline events={value} />}
        </DataView>
      </div>
      {state.status === "success" || state.status === "partial" ? (
        <LoadMore shown={state.data.value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="decisions" />
      ) : null}
    </Card>
  );
}
