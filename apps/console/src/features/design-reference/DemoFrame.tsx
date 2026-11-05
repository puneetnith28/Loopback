import type { ReactNode } from "react";
import { DEMO_SENTINEL } from "../../demo/fixtures.ts";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import styles from "./design.module.css";

/** Every fixture-backed specimen is framed and labelled DEMO: demonstration content can never pass for evidence. */
export function DemoFrame({ note, children }: { readonly note?: string; readonly children: ReactNode }) {
  return (
    <div className={styles.demoFrame} data-demo={DEMO_SENTINEL}>
      <div className={styles.demoTag}>
        <ProvenanceStamp source="demo" />
        <span className={styles.demoTagNote}>{note ?? "Demonstration fixture — not real data"}</span>
      </div>
      {children}
    </div>
  );
}
