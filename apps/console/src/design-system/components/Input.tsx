import { useId, type InputHTMLAttributes } from "react";
import { cx } from "./Button.tsx";
import { Icon } from "../Icon.tsx";
import styles from "./Field.module.css";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Always a visible label (placeholder is never a label). */
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly mono?: boolean;
}

export function Input({ label, hint, error, mono = false, required, className, "aria-describedby": callerDescribedBy, ...rest }: InputProps) {
  const id = useId();
  const describedBy = [callerDescribedBy, hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={id}>
        {label}{required ? <span className={styles.required} aria-hidden="true">*</span> : null}
      </label>
      <input
        id={id}
        className={cx(styles.control, mono && styles.mono)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
      {error ? <span id={`${id}-error`} className={styles.error} role="alert"><Icon name="alert-circle" size={14} />{error}</span> : null}
    </div>
  );
}
