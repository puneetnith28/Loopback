import { Icon } from "../Icon.tsx";
import styles from "./Overlay.module.css";

export function Breadcrumb({ items, label = "Breadcrumb" }: { readonly items: readonly { readonly label: string; readonly href?: string }[]; readonly label?: string }) {
  return (
    // Landmarks must be uniquely named when a page has more than one (axe landmark-unique).
    <nav aria-label={label}>
      <ol className={styles.crumbs}>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`}>
              {last || !item.href ? <span aria-current={last ? "page" : undefined}>{item.label}</span> : <a href={item.href}>{item.label}</a>}
              {last ? null : <Icon name="chevron-right" size={14} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
