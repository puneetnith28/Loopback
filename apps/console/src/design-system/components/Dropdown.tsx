import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { IconName } from "../Icon.tsx";
import { Icon } from "../Icon.tsx";
import { Button } from "./Button.tsx";
import styles from "./Overlay.module.css";

export interface MenuItem { readonly id: string; readonly label: string; readonly icon?: IconName; readonly onSelect: () => void }

/** Menu button (WAI-ARIA): arrows move, Enter/Space select, Escape closes and returns focus to the trigger. */
export function Dropdown({ label, items }: { readonly label: string; readonly items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    itemRefs.current[0]?.focus();
    const onDown = (e: MouseEvent) => { if (!(e.target instanceof Node && wrap.current?.contains(e.target))) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onMenuKey = (e: KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === "ArrowDown" ? (index === last ? 0 : index + 1) : e.key === "ArrowUp" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next !== null) { e.preventDefault(); itemRefs.current[next]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { trigger.current?.focus(); setOpen(false); }
  };

  return (
    <div className={styles.menuWrap} ref={wrap} onBlur={(e) => { if (!(e.relatedTarget instanceof Node && wrap.current?.contains(e.relatedTarget))) setOpen(false); }}>
      <Button ref={trigger} iconAfter="chevron-down" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open ? (
        <div role="menu" id={menuId} aria-label={label} className={styles.menu}>
          {items.map((item, i) => (
            <button
              key={item.id} ref={(el) => { itemRefs.current[i] = el; }} role="menuitem" type="button" tabIndex={-1}
              className={styles.menuItem} onKeyDown={(e) => onMenuKey(e, i)} onClick={() => { item.onSelect(); close(); }}
            >
              {item.icon ? <Icon name={item.icon} size={15} /> : null}{item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
