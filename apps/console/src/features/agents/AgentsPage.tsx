import { useState } from "react";
import { fromInfiniteQuery } from "../../api/loadable.ts";
import { useAuditFeed } from "../../api/queries.ts";
import { DataView } from "../../design-system/components/DataView.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Select } from "../../design-system/components/Select.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Card } from "../../design-system/components/Surface.tsx";
import { AGENT_EVENT_TYPES } from "../../lib/labels.ts";
import { AuditTimeline } from "../shared/AuditTimeline.tsx";
import { Freshness, LoadMore, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";

type AgentFilter = "all" | keyof typeof AGENT_EVENT_TYPES;

const FILTERS: readonly { readonly value: AgentFilter; readonly label: string }[] = [
  { value: "all", label: "All agent activity" },
  { value: "fixer", label: "Fixer" },
  { value: "verifier", label: "Verifier" },
  { value: "rejected", label: "Rejected agent output" },
];

const ALL_AGENT_TYPES = Object.values(AGENT_EVENT_TYPES).flat();

function typesFor(filter: AgentFilter): readonly string[] {
  return filter === "all" ? ALL_AGENT_TYPES : AGENT_EVENT_TYPES[filter];
}

function isAgentFilter(value: string): value is AgentFilter {
  return FILTERS.some((f) => f.value === value);
}

export function AgentsPage() {
  const [filter, setFilter] = useState<AgentFilter>("all");
  const query = useAuditFeed({ caseId: null, types: typesFor(filter) });
  const state = fromInfiniteQuery(query, {
    resource: "agent activity", isEmpty: (e) => e.length === 0,
    empty: { title: "No agent activity", detail: "The fixer and verifier have not acted on any case yet." },
  });
  return (
    <Page
      title="Agent activity" eyebrow="Fixer and verifier"
      description="What the agents did, as recorded by the gate. An agent's own statements are claims; only a validly signed verifier report counts as signed evidence."
    >
      <div className={shared.toolbar}>
        <Select label="Show" options={FILTERS} value={filter} onChange={(e) => { if (isAgentFilter(e.target.value)) setFilter(e.target.value); }} />
      </div>
      <Card level={2} title="How to read agent facts" eyebrow="Provenance">
        <ul className={shared.inlineList}>
          <li><ProvenanceStamp source="agent-claim" /></li>
          <li><ProvenanceStamp source="signed-verifier" /></li>
          <li><ProvenanceStamp source="gate" /></li>
        </ul>
      </Card>
      <DataView state={state} label="agent activity" skeleton={<Skeleton height={240} />}>
        {({ value, meta }) => (
          <>
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />
            <Card level={2} title="Activity" eyebrow="Audit log, newest first" flush>
              <div className={shared.pad}><AuditTimeline events={value} /></div>
              <LoadMore shown={value.length} hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoadMore={() => { void query.fetchNextPage(); }} noun="events" />
            </Card>
          </>
        )}
      </DataView>
    </Page>
  );
}
