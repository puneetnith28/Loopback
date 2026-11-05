import { useId, type InputHTMLAttributes } from "react";
import { cx } from "./Button.tsx";
import { Icon } from "../Icon.tsx";
import styles from "./Field.module.css";

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  /** Accessible label; visually hidden because the search icon and context make the purpose clear. */
  readonly label: string;
}

export function SearchInput({ label, className, ...rest }: SearchInputProps) {
  const id = useId();
  return (
    <div role="search" className={cx(styles.withIcon, className)}>
      <label htmlFor={id} className="visually-hidden">{label}</label>
      <span className={styles.leading}><Icon name="search" size={16} /></span>
      <input id={id} type="search" className={styles.control} autoComplete="off" spellCheck={false} {...rest} />
    </div>
  );
}
