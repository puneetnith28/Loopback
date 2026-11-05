import { PROVENANCE, type Provenance } from "../../lib/provenance.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { cx } from "./Button.tsx";
import styles from "./ProvenanceStamp.module.css";

const ICONS: Readonly<Record<Provenance, IconName>> = {
  github: "pull-request",
  gate: "shield",
  "signed-verifier": "seal",
  "agent-claim": "bot",
  demo: "flask",
};

/** Names a fact's source and trust category with icon AND text; colour is only a third cue. */
export function ProvenanceStamp({ source, compact = false }: { readonly source: Provenance; readonly compact?: boolean }) {
  const meta = PROVENANCE[source];
  return (
    <span className={cx(styles.stamp, styles[source], compact && styles.compact)} title={meta.description} data-provenance={source}>
      <span className={styles.source}>
        <Icon name={ICONS[source]} size={12} />
        {meta.label}
      </span>
      <span className={styles.trust}>{meta.trustLabel}</span>
      <span className="visually-hidden">: {meta.description}</span>
    </span>
  );
}
