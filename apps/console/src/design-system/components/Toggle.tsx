import styles from "./Field.module.css";

interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  /** Text shown for each state, so the state is never conveyed by position/colour alone. */
  readonly stateLabels?: readonly [off: string, on: string];
}

export function Toggle({ label, checked, onChange, disabled = false, stateLabels = ["Off", "On"] }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={styles.toggle} onClick={() => onChange(!checked)}>
      <span className={styles.track} aria-hidden="true"><span className={styles.thumb} /></span>
      <span>{label}</span>
      <span className={styles.toggleState} aria-hidden="true">{checked ? stateLabels[1] : stateLabels[0]}</span>
    </button>
  );
}
