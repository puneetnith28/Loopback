import type { SVGProps } from "react";

/**
 * Loopback icon set: one 20px grid, 1.6px stroke, round caps/joins. Hand-drawn (no icon dependency, no emoji).
 * Icons are decorative by default (aria-hidden); meaning always comes from adjacent text.
 */
const PATHS = {
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  x: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  "alert-triangle": "M10 3.2l7.4 13H2.6L10 3.2zM10 8.2v3.6M10 14.2v.1",
  "alert-circle": "M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4zM10 6.3v4.4M10 13.6v.1",
  info: "M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4zM10 9.2v4.6M10 6.4v.1",
  "pull-request": "M5.5 7.3a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 7.3v5.4M5.5 16.7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14.5 16.7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14.5 12.7V7.5a2 2 0 0 0-2-2H9.5M11 3.8L9.3 5.5 11 7.2",
  shield: "M10 2.8l6 2.3v4.6c0 3.7-2.5 6.3-6 7.5-3.5-1.2-6-3.8-6-7.5V5.1l6-2.3zM7.4 10l1.8 1.8L12.8 8",
  seal: "M10 2.6l1.7 1.3 2.1-.2.8 2 1.9.9-.3 2.1 1.2 1.7-1.2 1.8.3 2.1-1.9.9-.8 2-2.1-.2L10 18.4l-1.7-1.3-2.1.2-.8-2-1.9-.9.3-2.1L2.6 10.5l1.2-1.8-.3-2.1 1.9-.9.8-2 2.1.2L10 2.6zM7.2 10.4l1.9 1.9 3.8-4",
  bot: "M10 3.2v2.4M5.2 6.6h9.6a1.2 1.2 0 0 1 1.2 1.2v6.4a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 14.2V7.8a1.2 1.2 0 0 1 1.2-1.2zM7.6 10.4v.1M12.4 10.4v.1M8 13h4M2.4 10.2v2.2M17.6 10.2v2.2",
  flask: "M7.8 2.8h4.4M8.6 2.8v4.8L4.2 15.2a1.3 1.3 0 0 0 1.1 2h9.4a1.3 1.3 0 0 0 1.1-2l-4.4-7.6V2.8M6.2 12h7.6",
  user: "M10 9.4a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2zM4 17c.6-3 3-4.8 6-4.8s5.4 1.8 6 4.8",
  cpu: "M6.2 5.2h7.6a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1V6.2a1 1 0 0 1 1-1zM8.2 8.2h3.6v3.6H8.2zM8 2.8v2.4M12 2.8v2.4M8 14.8v2.4M12 14.8v2.4M2.8 8h2.4M2.8 12h2.4M14.8 8h2.4M14.8 12h2.4",
  commit: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.8 10H7M13 10h4.2",
  copy: "M7.4 7.4h7.8a1.2 1.2 0 0 1 1.2 1.2v7.8a1.2 1.2 0 0 1-1.2 1.2H7.4a1.2 1.2 0 0 1-1.2-1.2V8.6a1.2 1.2 0 0 1 1.2-1.2zM12.6 7.4V4.8a1.2 1.2 0 0 0-1.2-1.2H4.8a1.2 1.2 0 0 0-1.2 1.2v6.6a1.2 1.2 0 0 0 1.2 1.2h1.4",
  search: "M9 15.2a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4zM13.4 13.4l3.8 3.8",
  "chevron-down": "M5.5 8l4.5 4.5L14.5 8",
  "chevron-right": "M8 5.5l4.5 4.5L8 14.5",
  sun: "M10 13.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8zM10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M4.6 15.4l1.3-1.3M14.1 5.9l1.3-1.3",
  moon: "M16.2 12.4A6.8 6.8 0 0 1 7.6 3.8 6.8 6.8 0 1 0 16.2 12.4z",
  lock: "M5.6 9h8.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM7 9V6.6a3 3 0 0 1 6 0V9",
  refresh: "M16.2 9.4A6.2 6.2 0 0 0 5 6.2M3.8 10.6A6.2 6.2 0 0 0 15 13.8M5 2.8v3.4h3.4M15 17.2v-3.4h-3.4",
  clock: "M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4zM10 6v4.2l2.8 1.8",
  pending: "M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4z",
  current: "M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4zM10 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z",
  "seal-broken": "M10 2.6l1.7 1.3 2.1-.2.8 2 1.9.9-.3 2.1M17.4 10.5l-1.2 1.8.3 2.1-1.9.9-.8 2-2.1-.2L10 18.4l-1.7-1.3-2.1.2-.8-2-1.9-.9.3-2.1L2.6 10.5M8.4 7.6l3.2 4.8",
  terminal: "M3.6 4.4h12.8a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1zM6 8.2l2.4 2-2.4 2M10.4 12.6h3.6",
  "external-link": "M11.6 3.6h4.8v4.8M16.4 3.6l-7 7M14.2 11.4v4a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V6.8a1 1 0 0 1 1-1h4",
  more: "M5 10v.1M10 10v.1M15 10v.1",
  menu: "M3.5 5.5h13M3.5 10h13M3.5 14.5h13",
  layers: "M10 3l7 3.8-7 3.8-7-3.8L10 3zM3 10.4l7 3.8 7-3.8M3 13.8l7 3.8 7-3.8",
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  readonly name: IconName;
  readonly size?: number;
  /** Supply only when the icon alone carries meaning (it then gets role="img"). */
  readonly label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
  const a11y = label === undefined ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  return (
    <svg
      width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" focusable="false" {...a11y} {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
