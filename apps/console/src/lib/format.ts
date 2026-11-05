const FULL_SHA = /^[0-9a-f]{40}$/;

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/** 7-character display form. The full SHA is always available to assistive tech and on copy. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.345], ["month", 12], ["year", Number.POSITIVE_INFINITY],
];

/** "3 minutes ago" — `now` is injectable for tests. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  let value = (Date.parse(iso) - now.getTime()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return RELATIVE.format(Math.round(value), unit);
    value /= size;
  }
  return iso;
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
