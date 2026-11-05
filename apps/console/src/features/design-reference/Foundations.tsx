import { useState } from "react";
import { Button } from "../../design-system/components/Button.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
/** Obviously synthetic sample values for type specimens (not fixtures, not real). */
const SAMPLE_SHA = "0".repeat(40);
import styles from "./design.module.css";

export function Section({ id, num, title, text, children }: { readonly id: string; readonly num: string; readonly title: string; readonly text: string; readonly children: React.ReactNode }) {
  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <header className={styles.sectionHead}>
        <h2 id={`${id}-title`} className={styles.sectionTitle}><span className={styles.sectionNum}>{num}</span>{title}</h2>
        <p className={styles.sectionText}>{text}</p>
      </header>
      {children}
    </section>
  );
}

const SWATCHES: readonly [string, string][] = [
  ["--color-canvas", "Page background"], ["--color-surface", "Panels"], ["--color-raised", "Controls, raised layers"],
  ["--color-overlay", "Popovers, dialogs"], ["--color-inset", "Inputs, code, SHAs"], ["--color-border", "Separation"],
  ["--color-text", "Primary text"], ["--color-text-secondary", "Secondary text"], ["--color-text-tertiary", "Meta, captions"],
  ["--color-machine", "Machine activity"], ["--color-human", "Human action · awaiting a human"], ["--color-success", "Verified"],
  ["--color-danger", "Failed · blocked"], ["--color-demo", "DEMO fixtures only"], ["--color-focus", "Focus ring"],
];

export function ColorSection() {
  return (
    <Section id="color" num="01" title="Colour" text="Graphite neutrals carry the interface; each hue has exactly one meaning. Status is never conveyed by colour alone — icon and text always come first. Toggle the theme in the header: the light theme is tuned independently, not inverted.">
      <div className={styles.swatches}>
        {SWATCHES.map(([token, role]) => (
          <div key={token} className={styles.swatch}>
            <span className={styles.swatchChip} style={{ background: `var(${token})` }} aria-hidden="true" />
            <span className={styles.swatchMeta}><code className={styles.token}>{token}</code><span className={styles.role}>{role}</span></span>
          </div>
        ))}
      </div>
    </Section>
  );
}

const TYPE: readonly [string, string, string][] = [
  ["Display", "var(--text-3xl)", "Evidence before approval"],
  ["Page", "var(--text-2xl)", "Case title · Awaiting approval"],
  ["Panel", "var(--text-xl)", "Verification evidence"],
  ["Section", "var(--text-lg)", "The head moved after verification"],
  ["Body", "var(--text-md)", "The verifier ran the regression test at the parent commit and at the head."],
  ["Dense", "var(--text-sm)", "6 checks · 1 required approval · signed report"],
  ["Meta", "var(--text-xs)", "observed 3 minutes ago by the gate"],
];

export function TypeSection() {
  return (
    <Section id="type" num="02" title="Typography" text="IBM Plex Sans for the interface and IBM Plex Mono for anything a machine produced — SHAs, case ids, identifiers and numbers. Both are self-hosted. Counts use tabular numerals so updating values never shift.">
      <div>
        {TYPE.map(([name, size, sample]) => (
          <div key={name} className={styles.typeRow}>
            <span className={styles.typeMeta}>{name}<br />{size.replace("var(", "").replace(")", "")}</span>
            <span className={styles.typeSample} style={{ fontSize: size, fontWeight: name === "Body" || name === "Dense" || name === "Meta" ? 400 : 600 }}>{sample}</span>
          </div>
        ))}
        <div className={styles.typeRow}>
          <span className={styles.typeMeta}>Mono<br />identifiers</span>
          <span className={styles.row}><code className="numeric">LB-000</code><Sha value={SAMPLE_SHA} full copyable={false} /></span>
        </div>
        <div className={styles.typeRow}>
          <span className={styles.typeMeta}>Tabular<br />numerals</span>
          <span className="numeric" style={{ fontFamily: "var(--font-mono)" }}>1,204 · 0,087 · 9,316 · 11:42:07</span>
        </div>
      </div>
    </Section>
  );
}

const SPACE = ["1", "2", "3", "4", "6", "8", "12", "16"] as const;
const RADII = [["xs", "Chips"], ["sm", "Badges, stamps"], ["md", "Controls"], ["lg", "Panels"], ["xl", "Dialogs"]] as const;

export function SpaceSection() {
  return (
    <Section id="space" num="03" title="Space, radius & elevation" text="A 4px rhythm for every gap and inset. Radii stay small and concentric (outer = inner + padding). Borders separate; shadows appear only on layers that float above the page.">
      <div className={styles.split}>
        <div className={styles.stack}>
          {SPACE.map((s) => (
            <div key={s} className={styles.spaceRow}>
              <code className={styles.typeMeta}>--space-{s}</code>
              <span className={styles.spaceBar} style={{ width: `var(--space-${s})` }} aria-hidden="true" />
            </div>
          ))}
        </div>
        <div className={styles.radii}>
          {RADII.map(([r, use]) => (
            <div key={r} className={styles.radius}>
              <span className={styles.radiusBox} style={{ borderRadius: `var(--radius-${r})`, boxShadow: r === "xl" ? "var(--shadow-lg)" : r === "lg" ? "var(--shadow-md)" : undefined }} aria-hidden="true" />
              <code className={styles.typeMeta}>radius-{r}</code>
              <span className={styles.role}>{use}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

export function MotionSection() {
  const [on, setOn] = useState(false);
  return (
    <Section id="motion" num="04" title="Motion" text="Motion only communicates a change of state or preserves continuity. Transitions animate transform and opacity, never layout; exits are shorter than entrances; with reduced motion enabled, movement is removed entirely.">
      <div className={styles.stack}>
        <div className={styles.row}>
          {[["instant", "80ms", "Focus, badges"], ["fast", "160ms", "Buttons, hovers"], ["normal", "240ms", "Panels, tabs, the Loop"], ["slow", "400ms", "Page-level only"]].map(([n, d, use]) => (
            <span key={n} className={styles.swatchMeta} style={{ border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)" }}>
              <code className={styles.token}>--duration-{n} · {d}</code><span className={styles.role}>{use}</span>
            </span>
          ))}
        </div>
        <div className={on ? styles.motionOn : undefined}>
          <span className={styles.motionDemo} style={{ display: "block", transitionDuration: "var(--duration-normal)" }} aria-hidden="true" />
        </div>
        <div><Button size="sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>Play the standard transition</Button></div>
      </div>
    </Section>
  );
}
