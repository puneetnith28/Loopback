import { fromQuery } from "../../api/loadable.ts";
import { useConfigSummary, useSystemStatus } from "../../api/queries.ts";
import type { ConfigSummary, SystemStatus } from "../../api/schemas.ts";
import { Badge, StatusIndicator } from "../../design-system/components/Badge.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { Card } from "../../design-system/components/Surface.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { Freshness, Page } from "../shared/Page.tsx";
import shared from "../shared/shared.module.css";

export function SystemPage() {
  return (
    <Page title="System" eyebrow="Status and configuration" description="Gate readiness and the configuration the read API allowlists. Secrets, keys, identities and file paths are never served to the console.">
      <div className={shared.grid2}>
        <StatusCard />
        <SafetyCard />
      </div>
      <ConfigCard />
    </Page>
  );
}

const CHECK_GUIDANCE: Readonly<Record<string, string>> = {
  "switch-maintainers": "Maintainer room connection or heartbeat missing. Verify Switch credentials and maintainer room configuration.",
  "switch-intake": "Intake room connection or heartbeat missing. Verify Switch intake room configuration.",
  "switch-operations": "Operations room connection or heartbeat missing. Verify Switch operations room configuration.",
  github: "GitHub App authentication or API reachability failed. Check private key permissions or rate limits.",
  "not-halted": "The gate is in an administrative halted state. Maintainer command required to resume.",
};

function checkGuidance(name: string): string | null {
  if (CHECK_GUIDANCE[name]) return CHECK_GUIDANCE[name];
  if (name.startsWith("switch-")) return "Switch room connection or heartbeat timed out. Verify Switch credentials.";
  return null;
}

function StatusView({ status }: { readonly status: SystemStatus }) {
  return (
    <div className={shared.stack}>
      <StatusIndicator status={status.ok ? "verified" : "failed"} label={status.ok ? "The gate is ready" : "The gate is not ready"} />
      {status.failing.length > 0 ? (
        <div>
          <p className={shared.muted}>Failing readiness checks:</p>
          <ul className={shared.list}>
            {status.failing.map((name) => (
              <li key={name}>
                <span className={shared.mono}>{name}</span>
                {checkGuidance(name) ? <p className={shared.muted}>{checkGuidance(name)}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className={shared.muted}>Checked <time dateTime={status.checkedAt} title={absoluteTime(status.checkedAt)}>{relativeTime(status.checkedAt)}</time></p>
    </div>
  );
}

function StatusCard() {
  const query = useSystemStatus();
  const state = fromQuery(query, { resource: "gate readiness" });
  return (
    <Card level={2} title="Gate readiness" eyebrow="From the gate's /readyz" actions={<ProvenanceStamp source="gate" compact />}>
      <DataView state={state} label="gate readiness" skeleton={<Skeleton height={80} />}>
        {({ value, meta }) => (
          <>
            <StatusView status={value} />
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching} onRefresh={() => { void query.refetch(); }} />
          </>
        )}
      </DataView>
    </Card>
  );
}

function Flag({ label, on, meaning }: { readonly label: string; readonly on: boolean; readonly meaning: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {on ? <Badge tone="human" icon="alert-triangle">On</Badge> : <Badge tone="neutral" icon="lock">Off</Badge>}{" "}
        <span className={shared.muted}>{meaning}</span>
      </dd>
    </>
  );
}

function SafetyView({ config }: { readonly config: ConfigSummary }) {
  return (
    <dl className={shared.dl}>
      <Flag label="Merging" on={config.safety.mergeEnabled} meaning={config.safety.mergeEnabled ? "The gate may merge approved commits." : "The gate never merges."} />
      <Flag label="Privileged commands" on={config.safety.privilegedEnabled} meaning={config.safety.privilegedEnabled ? "Maintainers may approve, reject and merge." : "Approve, reject and merge are refused."} />
      <Flag label="Verifier isolation proven" on={config.safety.verifierIsolationProven} meaning={config.safety.verifierIsolationProven ? "Owner-declared after the isolation evidence." : "Verification stays advisory."} />
    </dl>
  );
}

function SafetyCard() {
  const query = useConfigSummary();
  const state = fromQuery(query, { resource: "safety flags" });
  return (
    <Card level={2} title="Safety flags" eyebrow="Read-only here; changed only by the owner" actions={<ProvenanceStamp source="gate" compact />}>
      <DataView state={state} label="safety flags" skeleton={<Skeleton height={96} />}>
        {({ value }) => <SafetyView config={value} />}
      </DataView>
    </Card>
  );
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

function ConfigView({ config }: { readonly config: ConfigSummary }) {
  return (
    <dl className={shared.dl}>
      <dt>Repository</dt><dd className={shared.mono}>{config.repo}</dd>
      <dt>Base branch</dt><dd className={shared.mono}>{config.baseBranch}</dd>
      <dt>Required checks</dt><dd>{config.requiredChecks.length > 0 ? <span className={shared.mono}>{config.requiredChecks.join(", ")}</span> : "none configured"}</dd>
      <dt>Verification mode</dt><dd>{config.verificationMode === "isolated" ? "Isolated (signed reports required)" : "Advisory (verifier not proven isolated)"}</dd>
      <dt>Approvals required</dt><dd className="numeric">{config.quorum}</dd>
      <dt>Gate in Switch</dt><dd className={shared.mono}>{config.gateMention}</dd>
      <dt>GitHub poll interval</dt><dd className="numeric">{seconds(config.pollIntervalMs)}</dd>
      <dt>Verification timeout</dt><dd className="numeric">{seconds(config.verifyTimeoutMs)}</dd>
      <dt>Fixer timeout</dt><dd className="numeric">{seconds(config.fixTimeoutMs)}</dd>
      <dt>Database schema</dt><dd className="numeric">version {config.schemaVersion}</dd>
    </dl>
  );
}

function ConfigCard() {
  const query = useConfigSummary();
  const state = fromQuery(query, { resource: "configuration" });
  return (
    <Card level={2} title="Configuration" eyebrow="Allowlisted, non-secret" actions={<ProvenanceStamp source="gate" compact />}>
      <DataView state={state} label="configuration" skeleton={<Skeleton height={200} />}>
        {({ value, meta }) => (
          <>
            <ConfigView config={value} />
            <Freshness generatedAt={meta.generatedAt} fetching={query.isFetching} onRefresh={() => { void query.refetch(); }} />
          </>
        )}
      </DataView>
    </Card>
  );
}
