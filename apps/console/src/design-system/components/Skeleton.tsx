import styles from "./Feedback.module.css";

/** Placeholder occupying the final layout's space (no shift when data arrives). Decorative: hidden from AT. */
export function Skeleton({ width = "100%", height = 12, radius }: { readonly width?: number | string; readonly height?: number; readonly radius?: number }) {
  return <span className={styles.skeleton} aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}
