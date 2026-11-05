import { useState, type FormEvent } from "react";
import { AUDIT_EVENT_TYPES, CaseId } from "@loopback/contracts";
import { fromInfiniteQuery } from "../../api/loadable.ts";
import { useAuditFeed } from "../../api/queries.ts";
import type { AuditEvent } from "../../api/schemas.ts";
import { Link, hrefFor, navigate } from "../../app/router.tsx";
import { Button } from "../../design-system/components/Button.tsx";
import { DataTable } from "../../design-system/components/DataTable.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { Input } from "../../design-system/components/Input.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Select } from "../../design-system/components/Select.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Surface } from "../../design-system/components/Surface.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { EVENT_LABELS, eventLabel, reasonLabel } from "../../lib/labels.ts";
import { revealHidden } from "../../lib/untrusted.ts";
import { formatPayload } from "../shared/AuditTimeline.tsx";
import { Freshness, LoadMore, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";

const ALL = "all";
const TYPE_OPTIONS = [{ value: ALL, label: "All event types" }, ...AUDIT_EVENT_TYPES.map((t) => ({ value: t, label: EVENT_LABELS[t] }))];

interface AuditPageProps {
  readonly caseId: string | null;
  readonly type: string | null;
}

export function AuditPage({ caseId, type }: AuditPageProps) {
  const query = useAuditFeed({ caseId, types: type ? [type] : [] });
  const state = fromInfiniteQuery(query, {
    resource: "audit events", isEmpty: (e) => e.length === 0,
    empty: { title: "No matching audit events", detail: caseId || type ? "Clear or change the filters." : "The gate has not recorded any events yet." },
  });
  return (
    <Page title="Audit history" eyebrow="Append-only log" description="Every event the gate recorded, newest first. Payloads are redacted by the API and shown as plain text.">
      <AuditFilters key={`${caseId ?? ""}|${type ?? ""}`} caseId={caseId} type={type} />
      <DataView state={state} label="audit events" skeleton={<Skeleton height={260} />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />
            <Surface>
              <AuditTable events={value} />
              <LoadMore shown={value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="events" />
            </Surface>
          </>
        )}
      </DataView>
    </Page>
  );
}

function AuditFilters({ caseId, type }: AuditPageProps) {
  const [draft, setDraft] = useState(caseId ?? "");
  const [error, setError] = useState<string | null>(null);
  const apply = (nextCase: string | null, nextType: string | null) => navigate(hrefFor({ name: "audit", caseId: nextCase, type: nextType }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim().toUpperCase();
    if (value !== "" && !CaseId.safeParse(value).success) {
      setError("Use the form LB-001 (three or more digits).");
      return;
    }
    setError(null);
    apply(value === "" ? null : value, type);
  };
  return (
    <form className={shared.toolbar} onSubmit={onSubmit} aria-label="Filter audit events">
      <Input label="Case" placeholder="LB-001" mono value={draft} onChange={(e) => setDraft(e.target.value)} {...(error ? { error } : {})} />
      <Select label="Event type" options={TYPE_OPTIONS} value={type ?? ALL} onChange={(e) => apply(caseId, e.target.value === ALL ? null : e.target.value)} />
      <Button type="submit" icon="search">Apply</Button>
      {caseId || type ? <Button variant="ghost" onClick={() => apply(null, null)}>Clear filters</Button> : null}
    </form>
  );
}

function AuditTable({ events }: { readonly events: readonly AuditEvent[] }) {
  return (
    <DataTable
      caption="Audit events" captionHidden rows={events} rowKey={(e) => String(e.id)}
      columns={[
        { key: "when", header: "When", render: (e) => <time dateTime={e.createdAt} title={absoluteTime(e.createdAt)}>{relativeTime(e.createdAt)}</time> },
        { key: "event", header: "Event", render: (e) => eventLabel(e.eventType) },
        { key: "case", header: "Case", render: (e) => (e.caseId ? <Link className={shared.mono} to={{ name: "case", id: e.caseId }}>{e.caseId}</Link> : <span className={shared.muted}>—</span>) },
        { key: "actor", header: "Actor", render: (e) => <span className={shared.mono}>{revealHidden(e.actorId, 256).text}</span> },
        { key: "reason", header: "Reason", render: (e) => (e.reasonCode ? <>{reasonLabel(e.reasonCode)} <span className={shared.mono}>({e.reasonCode})</span></> : <span className={shared.muted}>—</span>) },
        { key: "commit", header: "Commit", render: (e) => (e.targetSha ? <Sha value={e.targetSha} copyable={false} /> : <span className={shared.muted}>—</span>) },
        { key: "details", header: "Details (untrusted)", render: (e) => (Object.keys(e.payload).length > 0 ? <UntrustedText value={formatPayload(e.payload)} maxLength={240} /> : <span className={shared.muted}>—</span>) },
        { key: "source", header: "Source", render: (e) => <ProvenanceStamp source={e.provenance} compact /> },
      ]}
    />
  );
}
