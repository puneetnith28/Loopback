import { CASE_STATES, type CaseState } from "@loopback/contracts";
import { useState } from "react";
import { Alert } from "../../design-system/components/Alert.tsx";
import { Badge, StatusIndicator, type Status } from "../../design-system/components/Badge.tsx";
import { Breadcrumb } from "../../design-system/components/Breadcrumb.tsx";
import { Button, IconButton, cx } from "../../design-system/components/Button.tsx";
import { Checkbox } from "../../design-system/components/Checkbox.tsx";
import { DataTable, type Column } from "../../design-system/components/DataTable.tsx";
import { DataView } from "../../design-system/components/DataView.tsx";
import { Dialog } from "../../design-system/components/Dialog.tsx";
import { Dropdown } from "../../design-system/components/Dropdown.tsx";
import { Input } from "../../design-system/components/Input.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { SearchInput } from "../../design-system/components/SearchInput.tsx";
import { Select } from "../../design-system/components/Select.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { Skeleton } from "../../design-system/components/Skeleton.tsx";
import { StateTrack } from "../../design-system/components/StateTrack.tsx";
import { Surface } from "../../design-system/components/Surface.tsx";
import { Tabs } from "../../design-system/components/Tabs.tsx";
import { Timeline } from "../../design-system/components/Timeline.tsx";
import { Toggle } from "../../design-system/components/Toggle.tsx";
import { Tooltip } from "../../design-system/components/Tooltip.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { relativeTime } from "../../lib/format.ts";
import { STATE_LABELS } from "../../lib/lifecycle.ts";
import type { Loadable } from "../../lib/loadable.ts";
import { PROVENANCE, PROVENANCE_KINDS } from "../../lib/provenance.ts";
import { DEMO_CASES, DEMO_EVENTS, DEMO_HEAD, DEMO_MOVED_HEAD, DEMO_NOW, DEMO_OLD_HEAD, type DemoCase } from "../../demo/fixtures.ts";
import { DemoFrame } from "./DemoFrame.tsx";
import { Section } from "./Foundations.tsx";
import styles from "./design.module.css";

export function ActionsSection() {
  const [busy, setBusy] = useState(false);
  return (
    <Section id="actions" num="05" title="Actions" text="One quiet primary per view. Buttons press with a small scale, never transition everything, and keep a 40px hit area even when drawn smaller. Icon-only buttons always carry an accessible name.">
      <Surface className={styles.block}>
        {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
          <div key={v} className={styles.row}>
            <span className={styles.label} style={{ width: 80 }}>{v}</span>
            <Button variant={v} size="sm">Small</Button>
            <Button variant={v} icon="refresh">Re-request</Button>
            <Button variant={v} size="lg">Large</Button>
            <Button variant={v} disabled>Disabled</Button>
          </div>
        ))}
        <div className={styles.row}>
          <span className={styles.label} style={{ width: 80 }}>states</span>
          <Button variant="primary" busy={busy} onClick={() => { setBusy(true); window.setTimeout(() => setBusy(false), 1600); }}>Request verification</Button>
          <Tooltip content="Copies the full 40-character SHA"><IconButton icon="copy" label="Copy commit SHA" variant="secondary" /></Tooltip>
          <IconButton icon="refresh" label="Refresh" />
          <IconButton icon="external-link" label="Open on GitHub" size="sm" />
        </div>
      </Surface>
    </Section>
  );
}

export function FormsSection() {
  const [toggle, setToggle] = useState(true);
  return (
    <Section id="forms" num="06" title="Form controls" text="Labels are always visible and connected; hints and errors are linked with aria-describedby; native elements keep platform keyboard behaviour. Placeholders never replace labels.">
      <Surface className={styles.block}>
        <div className={styles.grid}>
          <Input label="Repository" placeholder="owner/name" hint="The single repository this console reads." mono defaultValue="puneetnith28/loopback-demo-target" />
          <Input label="Case id" required mono defaultValue="LB-42" error="Use the form LB-001 (three or more digits)." />
          <Select label="State filter" options={[{ value: "all", label: "All states" }, ...CASE_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] }))]} />
          <div className={styles.field} style={{ display: "grid", gap: 6, alignContent: "start" }}>
            <span className={styles.label}>Search</span>
            <SearchInput label="Search cases" placeholder="Search by id or summary" />
          </div>
        </div>
        <div className={styles.row}>
          <Checkbox label="Show merged cases" description="Merged cases are hidden by default." defaultChecked />
          <Checkbox label="Disabled option" disabled />
          <Toggle label="Compact rows" checked={toggle} onChange={setToggle} />
        </div>
      </Surface>
    </Section>
  );
}

const STATUSES: readonly Status[] = ["verified", "failed", "blocked", "running", "awaiting-human", "pending", "unknown"];

export function StatusSection() {
  return (
    <Section id="status" num="07" title="Status & provenance" text="Every status is icon + text with colour as a third cue. Every important fact can name its source: what the gate observed on GitHub, what policy decided, what a verifier signed, what an agent merely claims — and what is only a demonstration.">
      <div className={styles.split}>
        <Surface className={styles.block}>
          <span className={styles.label}>Status indicators</span>
          <div className={styles.stack} style={{ gap: 10 }}>{STATUSES.map((s) => <StatusIndicator key={s} status={s} />)}</div>
          <span className={styles.label}>Badges</span>
          <div className={styles.row}>
            <Badge>Neutral</Badge><Badge tone="machine" icon="cpu">Machine</Badge><Badge tone="human" icon="user">Human</Badge>
            <Badge tone="success" icon="check">Passed</Badge><Badge tone="danger" icon="x">Failed</Badge><Badge tone="demo" icon="flask">DEMO</Badge>
          </div>
        </Surface>
        <Surface className={styles.block}>
          <span className={styles.label}>Provenance stamps</span>
          <div className={styles.stack} style={{ gap: 12 }}>
            {PROVENANCE_KINDS.map((p) => (
              <div key={p} className={cx(styles.row, styles.provRow)}>
                <span className={styles.provStamp}><ProvenanceStamp source={p} /></span>
                <span className={cx(styles.role, styles.provRole)}>{PROVENANCE[p].description}.</span>
              </div>
            ))}
          </div>
        </Surface>
      </div>
    </Section>
  );
}

export function LifecycleSection() {
  const [state, setState] = useState<CaseState>("AwaitingApproval");
  const [moved, setMoved] = useState(false);
  return (
    <Section id="lifecycle" num="08" title="The Loop" text="A case's lifecycle over the 14 states defined in @loopback/contracts: ten on the main path and four detours drawn where they branch. Verification evidence is sealed to a full commit SHA; when the head moves, the seal breaks and evidence-dependent steps are shown as void — never as carried over.">
      <DemoFrame note="Explorer — pick any contract state; SHAs are fixtures">
        <div className={styles.panelBody}>
          <div className={styles.row}>
            <Select label="Case state" value={state} onChange={(e) => setState(e.target.value as CaseState)} options={CASE_STATES.map((s) => ({ value: s, label: STATE_LABELS[s] }))} />
            <Toggle label="Head moved after verification" checked={moved} onChange={setMoved} stateLabels={["No", "Yes"]} />
          </div>
          <StateTrack state={state} headSha={moved ? DEMO_MOVED_HEAD : DEMO_HEAD} evidenceSha={["Reported", "Triaged", "FixInProgress", "PRCreated", "Verifying", "Blocked"].includes(state) ? null : DEMO_HEAD} />
        </div>
      </DemoFrame>
      <div className={styles.grid}>
        <DemoFrame note="Stale — head moved"><div className={styles.panelBody}><StateTrack state="Stale" headSha={DEMO_MOVED_HEAD} evidenceSha={DEMO_OLD_HEAD} /></div></DemoFrame>
        <DemoFrame note="Merged — sealed"><div className={styles.panelBody}><StateTrack state="Merged" headSha={DEMO_HEAD} evidenceSha={DEMO_HEAD} /></div></DemoFrame>
      </div>
    </Section>
  );
}

export function TimelineSection() {
  return (
    <Section id="timeline" num="09" title="Timeline" text="Human actions (amber), machine actions (cyan), gate decisions, GitHub observations, verification, failures and rejections — each with its provenance. Agent and reporter text is untrusted and shown as plain text. The timeline renders only events it is given.">
      <DemoFrame note="Illustrative events — the provenance stamps show how real events will be labelled">
        <div className={styles.panelBody}><Timeline events={DEMO_EVENTS} now={DEMO_NOW} /></div>
      </DemoFrame>
    </Section>
  );
}

const COLUMNS: readonly Column<DemoCase>[] = [
  { key: "id", header: "Case", numeric: true, sortValue: (r) => r.id, render: (r) => <span style={{ color: "var(--color-text)" }}>{r.id}</span> },
  { key: "summary", header: "Report", render: (r) => <UntrustedText value={r.summary} maxLength={90} /> },
  { key: "state", header: "State", sortValue: (r) => r.state, render: (r) => STATE_LABELS[r.state] },
  { key: "verification", header: "Verification", render: (r) => <StatusIndicator status={r.verification} /> },
  { key: "head", header: "Head", render: (r) => (r.head ? <Sha value={r.head} copyable={false} /> : <span className={styles.role}>no PR yet</span>) },
  { key: "updated", header: "Updated", align: "end", numeric: true, sortValue: (r) => r.updated, render: (r) => <time dateTime={r.updated}>{relativeTime(r.updated, DEMO_NOW)}</time> },
];

function CasesTable({ rows }: { readonly rows: readonly DemoCase[] }) {
  return <DataTable caption="Cases (demonstration)" captionHidden columns={COLUMNS} rows={rows} rowKey={(r) => r.id} />;
}

const TABLE_SKELETON = (
  <div style={{ display: "grid", gap: 14, padding: 16 }}>
    {[0, 1, 2, 3].map((i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 70px) minmax(0, 1fr) minmax(0, 110px) minmax(0, 120px)", gap: 16 }}><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>)}
  </div>
);

export function TableSection() {
  return (
    <Section id="table" num="10" title="Data table" text="Semantic table with sortable columns (aria-sort), monospaced identifiers, tabular numbers and untrusted report text rendered safely — note the hidden direction-override character made visible in one of the demonstration reports.">
      <DemoFrame><CasesTable rows={DEMO_CASES} /></DemoFrame>
    </Section>
  );
}

export function StatesSection() {
  const loadables: readonly [string, string, Loadable<readonly DemoCase[]>][] = [
    ["loading", "Loading", { status: "loading" }],
    ["empty", "Empty", { status: "empty", title: "No open cases", detail: "Every reported bug is merged or closed. New reports appear here once a maintainer triages them." }],
    ["error", "Error", { status: "error", title: "Could not load cases", detail: "The read API did not respond. Nothing on this page has been changed.", retry: () => undefined }],
    ["partial", "Partial", { status: "partial", data: DEMO_CASES.slice(0, 3), missing: ["CI evidence", "verification runs"], retry: () => undefined }],
    ["success", "Success", { status: "success", data: DEMO_CASES.slice(0, 3) }],
    ["permission", "Permission", { status: "permission", boundary: "maintainers only", detail: "Case evidence is visible to maintainers. Ask a maintainer to add your Switch identity to the maintainer list." }],
  ];
  return (
    <Section id="states" num="11" title="Content states" text="Every data-dependent view handles six states through one exhaustive component, so none can be forgotten: loading keeps the final layout, empty explains the absence, error names what failed, partial shows what is available and what is not, permission names the boundary without leaking what is behind it.">
      <DemoFrame>
        <div className={styles.panelBody}>
          <Tabs label="Content states" items={loadables.map(([id, label, state]) => ({ id, label, content: <DataView label="cases" state={state} skeleton={TABLE_SKELETON}>{(rows) => <CasesTable rows={rows} />}</DataView> }))} />
        </div>
      </DemoFrame>
    </Section>
  );
}

export function OverlaysSection() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Section id="overlays" num="12" title="Navigation & overlays" text="Native modal dialog (inert background, Escape, focus returns to the opener), a keyboard-operable menu button, tooltips that also appear on focus, breadcrumbs and alerts.">
      <DemoFrame note="Fixture case id in the breadcrumb and alerts">
      <div className={styles.block}>
        <Breadcrumb label="Breadcrumb example" items={[{ label: "Cases", href: "#overlays" }, { label: "LB-042", href: "#overlays" }, { label: "Evidence" }]} />
        <div className={styles.row}>
          <Button onClick={() => setOpen(true)} icon="info">Why is approval in Switch?</Button>
          <Dropdown label="Copy" items={[
            { id: "id", label: "Copy case id", icon: "copy", onSelect: () => setPicked("Case id") },
            { id: "sha", label: "Copy head SHA", icon: "commit", onSelect: () => setPicked("Head SHA") },
          ]} />
          <span className={styles.role} role="status" aria-live="polite">{picked ? `${picked} selected (demonstration only — nothing copied)` : ""}</span>
        </div>
        <div className={styles.stack}>
          <Alert tone="info" title="Verification requested">The gate issued run 6f1c2b3a for the current head.</Alert>
          <Alert tone="attention" title="Awaiting a maintainer">Evidence is complete; approval happens in the maintainer room.</Alert>
          <Alert tone="danger" title="Merge outcome unknown">The gate is reconciling with GitHub. Do not retry the merge.</Alert>
        </div>
      </div>
      </DemoFrame>
      <Dialog open={open} onClose={() => setOpen(false)} title="Approval stays in Switch" footer={<Button variant="primary" onClick={() => setOpen(false)}>Understood</Button>}>
        <p>Approvals are bound to a maintainer's Switch identity and to the full head SHA. The console shows the evidence and the exact command but never sends it: adding a second approval path would weaken that binding.</p>
      </Dialog>
    </Section>
  );
}

export function AccessibilitySection() {
  const keys: readonly [string, string][] = [
    ["Tab / Shift+Tab", "Move between controls; focus is always visible"],
    ["← → Home End", "Move between tabs (selection follows focus)"],
    ["↑ ↓ Home End", "Move inside an open menu"],
    ["Enter / Space", "Activate buttons, menu items, switches"],
    ["Esc", "Close dialogs, menus and tooltips; focus returns to the trigger"],
  ];
  return (
    <Section id="a11y" num="13" title="Accessibility" text="WCAG 2.2 AA is the floor: contrast of every token pair is checked in tests, targets are at least 24px (40px for icon buttons), status is never colour alone, content reflows at 390px, and reduced motion removes movement.">
      <Surface className={styles.block}>
        <table className={styles.a11yTable}>
          <caption className="visually-hidden">Keyboard map</caption>
          <thead><tr><th scope="col">Keys</th><th scope="col">Behaviour</th></tr></thead>
          <tbody>{keys.map(([k, v]) => <tr key={k}><td>{k.split(" ").map((p) => <span key={p} className={styles.kbd} style={{ marginRight: 4 }}>{p}</span>)}</td><td>{v}</td></tr>)}</tbody>
        </table>
      </Surface>
    </Section>
  );
}
