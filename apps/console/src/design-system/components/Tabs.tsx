import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Overlay.module.css";

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly content: ReactNode;
}

/** WAI-ARIA tabs with roving tabindex: Left/Right/Home/End move and select (automatic activation). */
export function Tabs({ items, label, defaultId }: { readonly items: readonly TabItem[]; readonly label: string; readonly defaultId?: string }) {
  const base = useId();
  const [chosen, setSelected] = useState(defaultId ?? items[0]?.id);
  // If the chosen tab is gone, fall back to the first one so the tablist always has a tab stop.
  const selected = items.some((t) => t.id === chosen) ? chosen : items[0]?.id;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    const target = next === null ? undefined : items[next];
    if (next === null || !target) return;
    e.preventDefault();
    setSelected(target.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} className={styles.tablist}>
        {items.map((t, i) => (
          <button
            key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" type="button" id={`${base}-tab-${t.id}`}
            aria-selected={t.id === selected} aria-controls={`${base}-panel-${t.id}`} tabIndex={t.id === selected ? 0 : -1}
            className={styles.tab} onClick={() => setSelected(t.id)} onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}{t.count !== undefined ? <span className={styles.count}>{t.count}<span className="visually-hidden"> items</span></span> : null}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div key={t.id} role="tabpanel" id={`${base}-panel-${t.id}`} aria-labelledby={`${base}-tab-${t.id}`} hidden={t.id !== selected} tabIndex={0}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
