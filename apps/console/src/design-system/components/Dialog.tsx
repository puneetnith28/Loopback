import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import styles from "./Overlay.module.css";

interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/**
 * Native modal <dialog>: the platform makes the rest of the page inert, contains focus, and closes on Escape
 * (ECC motion-patterns rule 6). We add the label, scroll lock and focus return to the opener.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (open) {
      if (!el.open) {
        opener.current = document.activeElement;
        if (typeof el.showModal === "function") el.showModal(); else el.setAttribute("open", "");
      }
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = previous; };
    }
    if (!open && el.open) {
      el.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
      opener.current = null;
    }
    return undefined;
  }, [open]);
  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className={styles.dialogHeader}>
        <h2 id={titleId} className={styles.dialogTitle}>{title}</h2>
        <IconButton icon="x" label="Close dialog" onClick={onClose} />
      </div>
      <div className={styles.dialogBody}>{children}</div>
      {footer ? <div className={styles.dialogFooter}>{footer}</div> : null}
    </dialog>
  );
}
