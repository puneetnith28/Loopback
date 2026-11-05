import { revealHidden } from "../../lib/untrusted.ts";

/**
 * Renders untrusted content as plain text only (a React text node — never HTML). Hidden direction/zero-width
 * characters are shown as visible markers and long input is clamped.
 */
export function UntrustedText({ value, maxLength, block = false }: { readonly value: string; readonly maxLength?: number; readonly block?: boolean }) {
  const safe = revealHidden(value, maxLength);
  const note = safe.revealed > 0 ? ` (${safe.revealed} hidden character${safe.revealed === 1 ? "" : "s"} shown)` : "";
  const Tag = block ? "pre" : "span";
  return (
    <Tag data-untrusted="true" style={block ? { whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" } : undefined}>
      {safe.text}
      {note ? <span className="visually-hidden">{note}</span> : null}
    </Tag>
  );
}
