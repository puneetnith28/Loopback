import { useId, useState, type ReactNode } from "react";
import { Icon } from "../Icon.tsx";
import { cx } from "./Button.tsx";
import styles from "./DataTable.module.css";

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  readonly align?: "start" | "end";
  readonly numeric?: boolean;
  /** When present the column is sortable by this value. */
  readonly sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  readonly caption: string;
  readonly captionHidden?: boolean;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
}

/** Semantic table: real <th scope>, aria-sort on sortable headers, keyboard-scrollable region when wide. */
export function DataTable<T>({ caption, captionHidden = false, columns, rows, rowKey }: DataTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState<{ key: string; dir: "ascending" | "descending" } | null>(null);
  const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
  const sorted = column?.sortValue
    ? [...rows].sort((a, b) => {
        const av = column.sortValue!(a);
        const bv = column.sortValue!(b);
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sort?.dir === "ascending" ? cmp : -cmp;
      })
    : rows;
  return (
    <div className={styles.scroller} role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className={styles.table}>
        <caption id={captionId} className={captionHidden ? "visually-hidden" : undefined}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" className={cx(styles.th, c.align === "end" && styles.end)} aria-sort={c.sortValue ? (active ? sort.dir : "none") : undefined}>
                  {c.sortValue ? (
                    <button
                      type="button" className={styles.sort}
                      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === "ascending" ? "descending" : "ascending" } : { key: c.key, dir: "ascending" }))}
                    >
                      {c.header}<Icon name="chevron-down" size={12} className={styles.sortIcon} />
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={styles.row}>
              {columns.map((c) => (
                <td key={c.key} className={cx(styles.td, c.align === "end" && styles.end, c.numeric && styles.numeric)}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
