import { useId, type SelectHTMLAttributes } from "react";
import { cx } from "./Button.tsx";
import { Icon } from "../Icon.tsx";
import styles from "./Field.module.css";

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  readonly label: string;
  readonly hint?: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** Native <select>: platform keyboard behaviour and screen-reader support for free; only the box is styled. */
export function Select({ label, hint, options, className, "aria-describedby": callerDescribedBy, ...rest }: SelectProps) {
  const id = useId();
  const describedBy = [callerDescribedBy, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.withIcon}>
        <select id={id} className={cx(styles.control, styles.select)} aria-describedby={describedBy} {...rest}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className={styles.trailing}><Icon name="chevron-down" size={16} /></span>
      </div>
      {hint ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
    </div>
  );
}
