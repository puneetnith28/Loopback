import { cloneElement, useEffect, useId, useState, type ReactElement } from "react";
import styles from "./Overlay.module.css";

/**
 * Supplementary text for a focusable trigger (hover AND keyboard focus; Escape dismisses — WCAG 1.4.13).
 * Never put essential information or interactive content in a tooltip.
 */
export function Tooltip({ content, children }: { readonly content: string; readonly children: ReactElement<{ "aria-describedby"?: string }> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    // Escape dismisses the tooltip first (preventDefault stops the same keypress also cancelling an enclosing <dialog>).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span className={styles.tooltipWrap} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" ") })}
      <span role="tooltip" id={id} className={styles.tooltip} data-open={open}>{content}</span>
    </span>
  );
}
