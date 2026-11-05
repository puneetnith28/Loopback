import { fromInfiniteQuery, fromQuery } from "../../api/loadable.ts";
import { useCase, useCaseAudit, useConfigSummary } from "../../api/queries.ts";
import type { CaseDetail, ConfigSummary, GateDecision } from "../../api/schemas.ts";
import { Link } from "../../app/router.tsx";
import { Alert } from "../../design-system/components/Alert.tsx";
import { Badge, StatusIndicator } from "../../design-system/components/Badge.tsx";
import { Breadcrumb } from "../../design-system/components/Breadcrumb.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { ApprovalCommand, Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { StateTrack } from "../../design-system/components/StateTrack.tsx";
import { Card } from "../../design-system/components/Surface.tsx";
import { Tabs } from "../../design-system/components/Tabs.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { reasonLabel } from "../../lib/labels.ts";
import { STATE_LABELS } from "../../lib/lifecycle.ts";
import { revealHidden } from "../../lib/untrusted.ts";
import { AuditTimeline } from "../shared/AuditTimeline.tsx";
import { Freshness, LoadMore, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";
import { AppliesTo, Approvals, CiChecks, Commits, FixerClaimView, MergeOperations, VerificationRuns, evidenceCounts } from "./EvidenceSections.tsx";
import styles from "./caseDetail.module.css";

export function CaseDetailPage({ id }: { readonly id: string }) {
  const query = useCase(id);
  const config = useConfigSummary();
  const state = fromQuery(query, { resource: `case ${id}` });
  return (
    <Page title={id} eyebrow="Case evidence">
      <Breadcrumb label="Breadcrumb" items={[{ label: "Cases", href: "/cases" }, { label: id }]} />
      <DataView state={state} label={`case ${id}`} skeleton={<DetailSkeleton />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching} onRefresh={() => { void query.refetch(); }} />
            <CaseEvidence detail={value} config={config.data?.data ?? null} configFailed={config.status === "error"} />
          </>
        )}
      </DataView>
    </Page>
  );
}

/** True only when the API says verification evidence exists and it is bound to a different commit than the head. */
export function headMovedAfterEvidence(c: CaseDetail): boolean {
  return c.headSha !== null && c.evidence !== null && c.evidence.verifiedSha !== c.headSha;
}

function CaseEvidence({ detail: c, config, configFailed }: { readonly detail: CaseDetail; readonly config: ConfigSummary | null; readonly configFailed: boolean }) {
  const counts = evidenceCounts(c);
  return (
    <>
      {headMovedAfterEvidence(c) && c.evidence && c.headSha ? (
        <Alert tone="danger" title="The head commit moved after verification">
          The evidence was produced for <Sha value={c.evidence.verifiedSha} copyable={false} /> and does not apply to the current head{" "}
          <Sha value={c.headSha} copyable={false} />. The gate will not accept an approval until verification runs again.
        </Alert>
      ) : null}

      <div className={styles.top}>
        <Card level={2} title={STATE_LABELS[c.state]} eyebrow="Gate state" actions={<ProvenanceStamp source="gate" compact />}>
          <StateTrack state={c.state} headSha={c.headSha} evidenceSha={c.evidence?.verifiedSha ?? null} />
          <dl className={`${shared.dl} ${styles.summaryDl}`}>
            <dt>Repository</dt><dd className={shared.mono}>{c.repo}</dd>
            <dt>Pull request</dt><dd>{c.prNumber ? <span className={shared.mono}>#{c.prNumber}</span> : "None yet"}</dd>
            <dt>Branch</dt><dd>{c.branch ? <span className={shared.mono}>{revealHidden(c.branch, 255).text}</span> : "None yet"}</dd>
            <dt>In this state since</dt><dd><time dateTime={c.stateEnteredAt} title={absoluteTime(c.stateEnteredAt)}>{relativeTime(c.stateEnteredAt)}</time></dd>
            {c.blockedReason ? <><dt>Blocked because</dt><dd>{reasonLabel(c.blockedReason)} <span className={shared.mono}>({c.blockedReason})</span></dd></> : null}
          </dl>
        </Card>
        <ApprovalCard detail={c} config={config} configFailed={configFailed} />
      </div>

      <Card level={2} title="Report" eyebrow="From the reporter — untrusted text">
        <div className={styles.untrusted}><UntrustedText value={c.reportText} block /></div>
        {c.prSnapshot === null ? <p className={shared.muted}>Pull-request title, author and changed files are not available from the read API yet (backend requirement R3).</p> : null}
      </Card>

      <Tabs
        label="Case evidence"
        items={[
          {
            id: "evidence", label: "Evidence", count: counts.evidence,
            content: (
              <div className={shared.grid2}>
                <Card level={3} title="Verification" eyebrow="Verifier and gate"><VerificationRuns runs={c.verificationRuns} headSha={c.headSha} /></Card>
                <Card level={3} title="CI checks" eyebrow="Observed on GitHub"><CiChecks checks={c.ciChecks} headSha={c.headSha} /></Card>
              </div>
            ),
          },
          { id: "commits", label: "Commits", count: counts.commits, content: <Card level={3} title="Commit history" eyebrow="Observed on GitHub"><Commits commits={c.commits} headSha={c.headSha} /></Card> },
          { id: "claims", label: "Agent claims", content: <Card level={3} title="Fixer report" eyebrow="Agent claim"><FixerClaimView claim={c.fixerClaim} headSha={c.headSha} /></Card> },
          {
            id: "decisions", label: "Approvals & merge", count: counts.decisions,
            content: (
              <div className={shared.grid2}>
                <Card level={3} title="Maintainer decisions" eyebrow="Recorded by the gate"><Approvals approvals={c.approvals} headSha={c.headSha} /></Card>
                <Card level={3} title="Merge attempts" eyebrow="Recorded by the gate"><MergeOperations operations={c.mergeOperations} /></Card>
              </div>
            ),
          },
          { id: "activity", label: "Activity", content: <CaseActivity id={c.id} /> },
        ]}
      />
    </>
  );
}

function GateDecisionView({ decision, headSha }: { readonly decision: GateDecision | null; readonly headSha: string | null }) {
  if (decision === null) return <p className={shared.muted}>The gate has not evaluated a merge for this case yet.</p>;
  return (
    <div className={styles.decision}>
      <div className={styles.factHead}>
        <StatusIndicator status={decision.outcome === "allowed" ? "verified" : "blocked"} label={decision.outcome === "allowed" ? "Gate allowed the merge" : "Gate blocked the merge"} />
        <ProvenanceStamp source={decision.provenance} compact />
      </div>
      <div className={styles.factMeta}>
        <span>for</span><Sha value={decision.headSha} copyable={false} /><AppliesTo sha={decision.headSha} headSha={headSha} />
        <span>evaluated <time dateTime={decision.observedAt} title={absoluteTime(decision.observedAt)}>{relativeTime(decision.observedAt)}</time></span>
      </div>
      {decision.reasonCodes.length > 0 ? (
        <ul className={shared.list}>
          {decision.reasonCodes.map((code) => <li key={code}>{reasonLabel(code)} <span className={shared.mono}>({code})</span></li>)}
        </ul>
      ) : null}
    </div>
  );
}

function ApprovalCard({ detail: c, config, configFailed }: { readonly detail: CaseDetail; readonly config: ConfigSummary | null; readonly configFailed: boolean }) {
  const awaiting = c.state === "AwaitingApproval";
  return (
    <Card level={2} title="Approval" eyebrow="A human decision, made in Switch">
      <div className={shared.stack}>
        <GateDecisionView decision={c.lastGateDecision} headSha={c.headSha} />
        {!awaiting ? (
          <p className={shared.muted}>No approval is requested: the case is in “{STATE_LABELS[c.state]}”. The gate asks for approval only in “Awaiting approval”.</p>
        ) : config === null ? (
          <p className={shared.muted} role="note">
            {configFailed ? "The approval command cannot be shown because the gate's configuration could not be loaded." : "Loading the gate's Switch mention…"}
          </p>
        ) : (
          <>
            {config.verificationMode === "advisory" ? (
              <Badge tone="human" icon="alert-triangle" wrap>Verification is advisory: the verifier is not proven isolated</Badge>
            ) : null}
            <ApprovalCommand caseId={c.id} headSha={c.headSha ?? ""} verifiedSha={c.evidence?.verifiedSha ?? null} gateMention={config.gateMention} />
          </>
        )}
        <p className={shared.muted}>The console cannot approve or merge. <Link to={{ name: "audit", caseId: c.id, type: null }}>Audit history for {c.id}</Link></p>
      </div>
    </Card>
  );
}

function CaseActivity({ id }: { readonly id: string }) {
  const query = useCaseAudit(id);
  const state = fromInfiniteQuery(query, {
    resource: `activity for ${id}`, isEmpty: (e) => e.length === 0,
    empty: { title: "No recorded activity", detail: "The audit log has no events for this case yet." },
  });
  return (
    <Card level={3} title="Case activity" eyebrow="Audit log" flush>
      <div className={styles.pad}>
        <DataView state={state} label={`activity for ${id}`} skeleton={<Skeleton height={120} />}>
          {({ value }) => <AuditTimeline events={value} />}
        </DataView>
      </div>
      {state.status === "success" || state.status === "partial" ? (
        <LoadMore shown={state.data.value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="events" />
      ) : null}
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className={shared.stack}>
      <Skeleton height={14} width="30%" />
      <div className={styles.top}><Skeleton height={220} /><Skeleton height={220} /></div>
      <Skeleton height={160} />
    </div>
  );
}
