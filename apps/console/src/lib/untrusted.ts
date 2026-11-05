/**
 * Untrusted text (issue reports, agent output, logs, audit payloads, branch names) is only ever rendered as a
 * React text node — never as HTML. Hidden characters that can reorder or disguise text (Trojan Source: bidi
 * controls, zero-width characters) are replaced by visible markers, and length is clamped.
 */
/**
 * Everything that renders invisibly or can disguise text: all format characters (Cf: bidi controls, zero-width
 * characters, soft hyphen, Arabic letter mark, Mongolian vowel separator, tag characters U+E0000-E007F), line and
 * paragraph separators, invisible fillers and joiners (U+034F, U+115F, U+1160, U+3164, U+FFA0), variation
 * selectors, and every C0/C1 control except newline, tab and carriage return. Matching them is the point.
 */
// Combining marks (U+034F, variation selectors) sit in their own alternatives so no class mixes them with base
// characters (ESLint no-misleading-character-class); the matched set is the same.
const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]|\u034F|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]|(?![\t\n\r])\p{Cc}/gu;

const marker = (c: string): string => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;

export interface SafeText {
  readonly text: string;
  readonly revealed: number;
  readonly truncated: boolean;
}

export function revealHidden(input: string, maxLength = 4000): SafeText {
  let revealed = 0;
  const marked = input.replace(HIDDEN, (c) => {
    revealed += 1;
    return marker(c);
  });
  const truncated = marked.length > maxLength;
  return { text: truncated ? `${marked.slice(0, maxLength)}…` : marked, revealed, truncated };
}

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./#?=&-]*)?$/;
const DOT_SEGMENT = /\/\.{1,2}(?=[/?#]|$)/;

/**
 * Only canonical GitHub repository URLs may become links; everything else stays text. The string must match the
 * allow-list, contain no dot segments, and survive URL parsing unchanged on https://github.com with no credentials
 * or port.
 */
export function safeGitHubUrl(value: string): string | null {
  if (!GITHUB_URL.test(value) || DOT_SEGMENT.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const exact = url.protocol === "https:" && url.hostname === "github.com" && url.port === "" && url.username === "" && url.password === "" && url.href === value;
  return exact ? value : null;
}
