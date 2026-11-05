import { Alert } from "../../design-system/components/Alert.tsx";
import { Breadcrumb } from "../../design-system/components/Breadcrumb.tsx";
import { Card } from "../../design-system/components/Surface.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { ApprovalCommand, Sha } from "../../design-system/components/Sha.tsx";
import { StateTrack } from "../../design-system/components/StateTrack.tsx";
import { StatusIndicator } from "../../design-system/components/Badge.tsx";
import { Timeline } from "../../design-system/components/Timeline.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { DEMO_CASES, DEMO_EVENTS, DEMO_HEAD, DEMO_NOW } from "../../demo/fixtures.ts";
import { DemoFrame } from "./DemoFrame.tsx";
import { ColorSection, MotionSection, SpaceSection, TypeSection } from "./Foundations.tsx";
import {
  AccessibilitySection, ActionsSection, FormsSection, LifecycleSection, OverlaysSection, StatesSection, StatusSection, TableSection, TimelineSection,
} from "./Specimens.tsx";
import styles from "./design.module.css";

const TOC: readonly { group: string; items: readonly [string, string, string][] }[] = [
  { group: "Foundations", items: [["color", "01", "Colour"], ["type", "02", "Typography"], ["space", "03", "Space & radius"], ["motion", "04", "Motion"]] },
  { group: "Components", items: [["actions", "05", "Actions"], ["forms", "06", "Forms"], ["status", "07", "Status & provenance"], ["lifecycle", "08", "The Loop"], ["timeline", "09", "Timeline"], ["table", "10", "Data table"], ["states", "11", "Content states"], ["overlays", "12", "Overlays"]] },
  { group: "Quality", items: [["a11y", "13", "Accessibility"]] },
];

function EvidenceSpecimen() {
  const c = DEMO_CASES[0]!;
  return (
    <DemoFrame note="Specimen: how a case's evidence will read once the read API exists">
      <div className={styles.split} style={{ padding: "var(--space-4)" }}>
        <div className={styles.specimen}>
          <div className={styles.caseHead}>
            <Breadcrumb items={[{ label: "Cases", href: "#top" }, { label: c.id }]} />
            <h2 className={styles.caseTitle}><span className={styles.caseId}>{c.id}</span><UntrustedText value={c.summary} /></h2>
          </div>
          <StateTrack state={c.state} headSha={DEMO_HEAD} evidenceSha={DEMO_HEAD} />
          <Card title="Evidence for the current head" eyebrow="Ledger" titleId="ledger-title" flush>
            <div className={styles.facts} style={{ padding: "0 var(--space-4)" }}>
              <div className={styles.fact}><div><div className={styles.factLabel}>Required check · test</div><div className={styles.factValue}><StatusIndicator status="verified" label="Passed" detail="on this head" /></div></div><ProvenanceStamp source="github" /></div>
              <div className={styles.fact}><div><div className={styles.factLabel}>Independent verification</div><div className={styles.factValue}><StatusIndicator status="verified" detail="regression test fails before the fix" /></div></div><ProvenanceStamp source="signed-verifier" /></div>
              <div className={styles.fact}><div><div className={styles.factLabel}>Fixer report</div><div className={styles.factValue}><UntrustedText value="Added a regression test; 6 tests pass" /></div></div><ProvenanceStamp source="agent-claim" /></div>
              <div className={styles.fact}><div><div className={styles.factLabel}>Merge policy</div><div className={styles.factValue}><StatusIndicator status="awaiting-human" detail="1 maintainer approval for this exact SHA" /></div></div><ProvenanceStamp source="gate" /></div>
              <div className={styles.fact}><div><div className={styles.factLabel}>Head commit</div><div className={styles.factValue}><Sha value={DEMO_HEAD} full /></div></div><ProvenanceStamp source="github" /></div>
            </div>
          </Card>
          <Card title="Approve in Switch" eyebrow="Human decision" titleId="approve-title">
            <ApprovalCommand caseId={c.id} headSha={DEMO_HEAD} verifiedSha={DEMO_HEAD} />
          </Card>
        </div>
        <Card title="Activity" eyebrow="Timeline" titleId="activity-title">
          <Timeline events={[...DEMO_EVENTS].filter((e) => e.kind !== "failure" && e.kind !== "rejection").reverse()} now={DEMO_NOW} />
        </Card>
      </div>
    </DemoFrame>
  );
}

export default function DesignPage() {
  return (
    <div className={styles.page} id="top">
      <div className={styles.banner}>
        <Alert tone="demo" title="Design reference — demonstration content only">
          Every case, event, SHA and result on this page is a fixture, labelled DEMO. This page is excluded from production builds.
        </Alert>
      </div>
      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="Design reference sections">
          <ul className={styles.tocList}>
            {TOC.map((g) => (
              <li key={g.group} className={styles.tocGroup}>
                <span className={styles.tocHeading}>{g.group}</span>
                {g.items.map(([id, num, label]) => <a key={id} className={styles.tocLink} href={`#${id}`}><span className={styles.tocNum}>{num}</span>{label}</a>)}
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.content}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>Loopback · Design reference</span>
            <h1 className={styles.title}>The Evidence Ledger</h1>
            <p className={styles.lede}>A calm, precise interface for one decision: does an AI-generated fix have enough trustworthy evidence to deserve a human's approval? Every fact names its source, every commit is sealed, and approval stays with a human in Switch.</p>
            <EvidenceSpecimen />
          </div>
          <ColorSection /><TypeSection /><SpaceSection /><MotionSection />
          <ActionsSection /><FormsSection /><StatusSection /><LifecycleSection /><TimelineSection /><TableSection /><StatesSection /><OverlaysSection />
          <AccessibilitySection />
        </div>
      </div>
    </div>
  );
}
