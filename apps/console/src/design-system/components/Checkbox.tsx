import type { InputHTMLAttributes } from "react";
import styles from "./Field.module.css";

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly label: string;
  readonly description?: string;
}

export function Checkbox({ label, description, ...rest }: CheckboxProps) {
  return (
    <label className={styles.check}>
      <input type="checkbox" {...rest} />
      <span className={styles.checkText}>
        <span>{label}</span>
        {description ? <span className={styles.hint}>{description}</span> : null}
      </span>
    </label>
  );
}
