import { useEffect, useState } from "react";
import { CaseId, FullSha } from "@loopback/contracts";
import { shortSha } from "../../lib/format.ts";
import { IconButton, cx } from "./Button.tsx";
import styles from "./Sha.module.css";

/** How long a "Copied" confirmation stays before the live region clears (so the next copy is announced again). */
const COPY_FEEDBACK_MS = 2500;
/** A Switch mention: one token, no spaces, so it cannot smuggle extra words into the command. */
const GATE_MENTION = /^@[a-z0-9][a-z0-9._-]*$/;

type CopyStatus = "idle" | "ok" | "failed";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy with transient feedback; the status resets after a delay and whenever the copied value changes. */
function useCopy(value: string): readonly [CopyStatus, () => void] {
  const [state, setState] = useState<{ readonly value: string; readonly status: CopyStatus }>({ value, status: "idle" });
  const status = state.value === value ? state.status : "idle";
  useEffect(() => {
    if (status === "idle") return undefined;
    const timer = window.setTimeout(() => setState({ value, status: "idle" }), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [status, value]);
  const copy = () => { void copyText(value).then((ok) => setState({ value, status: ok ? "ok" : "failed" })); };
  return [status, copy];
}

/** Shows a commit SHA. `full` renders all 40 characters (required wherever evidence is bound to it). */
export function Sha({ value, full = false, copyable = true }: { readonly value: string; readonly full?: boolean; readonly copyable?: boolean }) {
  const valid = FullSha.safeParse(value).success;
  const [copied, copy] = useCopy(value);
  const shown = full || !valid ? value : shortSha(value);
  return (
    <span className={cx(styles.sha, full && styles.full)}>
      <code className={styles.value} title={value} aria-label={`commit ${value}`}>{shown}</code>
      {copyable && valid ? (
        <IconButton icon="copy" size="sm" label={`Copy full commit SHA ${value}`} onClick={copy} />
      ) : null}
      <span className={styles.copied} role="status" aria-live="polite">{copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : ""}</span>
    </span>
  );
}

interface ApprovalCommandProps {
  readonly caseId: string;
  /** The case's CURRENT head, as reported by the gate. */
  readonly headSha: string;
  /** The commit the API reports passing verification for (null when there is none). Never computed in the browser. */
  readonly verifiedSha: string | null;
  readonly gateMention?: string;
}

/** The exact command, or null unless every part is well-formed and the verification is for exactly this head. */
export function approvalCommandFor({ caseId, headSha, verifiedSha, gateMention = "@loopback-gate" }: ApprovalCommandProps): string | null {
  const wellFormed = CaseId.safeParse(caseId).success && FullSha.safeParse(headSha).success && GATE_MENTION.test(gateMention);
  return wellFormed && verifiedSha === headSha ? `${gateMention} approve ${caseId} ${headSha}` : null;
}

/**
 * The console never approves. It shows the exact Switch command for the maintainer to send, and only when
 * verification passed for the current head. Every part is validated, so the copied text is exactly what is shown.
 * The full SHA is always visible: checking it is deliberate friction.
 */
export function ApprovalCommand(props: ApprovalCommandProps) {
  const command = approvalCommandFor(props);
  const [copied, copy] = useCopy(command ?? "");
  if (command === null) {
    return (
      <p className={styles.commandNote} role="note">
        No approval command: there is no passing verification for the current head. The gate refuses approvals
        for any other commit.
      </p>
    );
  }
  return (
    <div className={styles.command}>
      <div className={styles.commandRow}>
        <code className={styles.commandText}><span className={styles.prompt} aria-hidden="true">Switch ›</span>{command}</code>
        <IconButton icon="copy" size="sm" label="Copy approval command" onClick={copy} />
      </div>
      <p className={styles.commandNote}>
        Send this in the maintainer room. The console does not approve; the gate re-checks the head, CI and
        verification before accepting it. <span role="status" aria-live="polite">{copied === "ok" ? "Command copied." : copied === "failed" ? "Copy failed." : ""}</span>
      </p>
    </div>
  );
}
