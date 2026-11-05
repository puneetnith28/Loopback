import type { ReactNode } from "react";
import type { Approval, CaseDetail, CiCheck, Commit, FixerClaim, MergeOperation, VerificationRun } from "../../api/schemas.ts";
import { Alert } from "../../design-system/components/Alert.tsx";
import { Badge, StatusIndicator, type Status } from "../../design-system/components/Badge.tsx";
import { ProvenanceStamp } from "../../design-system/components/ProvenanceStamp.tsx";
import { Sha } from "../../design-system/components/Sha.tsx";
import { UntrustedText } from "../../design-system/components/UntrustedText.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { reasonLabel } from "../../lib/labels.ts";
import { revealHidden, safeGitHubUrl } from "../../lib/untrusted.ts";
import shared from "../shared/shared.module.css";
import styles from "./caseDetail.module.css";

/**
 * Whether a fact is about the case's CURRENT head. A fact recorded for an earlier commit is never shown as
 * applying to the new one (DESIGN.md §2): it is labelled and visually de-emphasised. This is a display comparison
 * of two SHAs from the API, not a readiness decision.
 */
export function AppliesTo({ sha, headSha }: { readonly sha: string; readonly headSha: string | null }) {
  if (headSha === null) return null;
  return sha === headSha
    ? <Badge tone="success" icon="seal">Current head</Badge>
    : <Badge tone="human" icon="seal-broken" wrap>Earlier commit — does not apply to the current head</Badge>;
}

function When({ iso }: { readonly iso: string }) {
  return <time dateTime={iso} title={absoluteTime(iso)}>{relativeTime(iso)}</time>;
}

function Fact({ children, stale, provenance }: { readonly children: ReactNode; readonly stale: boolean; readonly provenance: ReactNode }) {
  return (
    <li className={styles.fact} data-stale={stale}>
      <div className={styles.factBody}>{children}</div>
      <div className={styles.factSource}>{provenance}</div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function checkStatus(c: CiCheck): { status: Status; label: string } {
  if (c.status !== "completed") return { status: "running", label: c.status.replace(/_/g, " ") };
  if (c.conclusion === "success") return { status: "verified", label: "Success" };
  if (c.conclusion === "neutral" || c.conclusion === "skipped") return { status: "unknown", label: c.conclusion };
  return { status: "failed", label: c.conclusion ?? "No conclusion" };
}

export function CiChecks({ checks, headSha }: { readonly checks: readonly CiCheck[]; readonly headSha: string | null }) {
  if (checks.length === 0) return <p className={shared.muted}>The gate has not observed any CI checks for this case.</p>;
  return (
    <ul className={styles.facts} aria-label="CI checks observed on GitHub">
      {checks.map((c) => {
        const s = checkStatus(c);
        const url = safeGitHubUrl(c.htmlUrl);
        return (
          <Fact key={c.id} stale={headSha !== null && c.headSha !== headSha} provenance={<ProvenanceStamp source={c.provenance} compact />}>
            <div className={styles.factHead}>
              <span className={styles.factTitle}>{revealHidden(c.checkName, 200).text}</span>
              <StatusIndicator status={s.status} label={s.label} />
            </div>
            <div className={styles.factMeta}>
              <span>by <span className={shared.mono}>{revealHidden(c.appSlug, 100).text}</span></span>
              <span>observed <When iso={c.observedAt} /></span>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" data-external>View on GitHub<span className="visually-hidden"> (opens in a new tab)</span></a> : null}
            </div>
            <div className={styles.factMeta}><Sha value={c.headSha} copyable={false} /><AppliesTo sha={c.headSha} headSha={headSha} /></div>
          </Fact>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export const RUN_STATUS: Readonly<Record<VerificationRun["status"], { status: Status; label: string }>> = {
  pass: { status: "verified", label: "Passed" },
  fail: { status: "failed", label: "Failed" },
  invalid: { status: "failed", label: "Invalid report" },
  timeout: { status: "failed", label: "Timed out" },
  requested: { status: "running", label: "Running" },
  superseded: { status: "unknown", label: "Superseded" },
};

export const SIGNATURE_TEXT: Readonly<Record<NonNullable<VerificationRun["signature"]>, string>> = {
  valid: "Signature valid", absent: "Not signed", unverified: "Signature not checked (no key configured)", invalid: "Signature invalid",
};

export function RunFacts({ run }: { readonly run: VerificationRun }) {
  const s = RUN_STATUS[run.status];
  return (
    <>
      <div className={styles.factHead}>
        <span className={styles.factTitle}>Verification run</span>
        <StatusIndicator status={s.status} label={s.label} />
        {run.mode === "advisory" ? <Badge tone="human" icon="alert-triangle">Advisory — not isolated</Badge> : null}
        {run.mode === "isolated" ? <Badge tone="machine" icon="shield">Isolated</Badge> : null}
      </div>
      <div className={styles.factMeta}>
        <span>{run.signature ? SIGNATURE_TEXT[run.signature] : "Signature not recorded yet"}</span>
        <span>requested <When iso={run.requestedAt} /></span>
        {run.completedAt ? <span>completed <When iso={run.completedAt} /></span> : null}
        <span>Regression test fails before the fix: {run.regressionTestFailsBeforeFix === null ? "not reported" : run.regressionTestFailsBeforeFix ? "yes" : "no"}</span>
      </div>
      {run.summary ? <p className={styles.untrusted}><UntrustedText value={run.summary} /></p> : null}
      {run.findings.length > 0 ? (
        <ul className={styles.findings}>
          {run.findings.map((f, i) => (
            <li key={`${run.id}-${i}`}>
              <Badge tone={f.severity === "high" ? "danger" : f.severity === "medium" ? "human" : "neutral"}>{f.severity}</Badge>{" "}
              {f.file ? <span className={shared.mono}>{revealHidden(f.file, 300).text}: </span> : null}
              <UntrustedText value={f.message} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function VerificationRuns({ runs, headSha }: { readonly runs: readonly VerificationRun[]; readonly headSha: string | null }) {
  if (runs.length === 0) return <p className={shared.muted}>No verification has been requested for this case.</p>;
  return (
    <ul className={styles.facts} aria-label="Verification runs">
      {runs.map((run) => (
        <Fact key={run.id} stale={headSha !== null && run.headSha !== headSha} provenance={<ProvenanceStamp source={run.provenance} compact />}>
          <RunFacts run={run} />
          <div className={styles.factMeta}><Sha value={run.headSha} copyable={false} /><AppliesTo sha={run.headSha} headSha={headSha} /></div>
        </Fact>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function Commits({ commits, headSha }: { readonly commits: readonly Commit[]; readonly headSha: string | null }) {
  if (commits.length === 0) return <p className={shared.muted}>No commits observed yet: the fixer has not opened a pull request.</p>;
  return (
    <>
      {commits.length > 1 ? (
        <Alert tone="attention" title={`The head commit changed ${commits.length - 1} time${commits.length > 2 ? "s" : ""}`}>
          Evidence, CI results and approvals recorded for an earlier commit do not apply to the current head.
        </Alert>
      ) : null}
      <ol className={styles.facts} aria-label="Commits observed on the pull request, oldest first">
        {commits.map((c) => (
          <Fact key={c.headSha} stale={headSha !== null && c.headSha !== headSha} provenance={<ProvenanceStamp source={c.provenance} compact />}>
            <div className={styles.factHead}><span className={styles.factTitle}>Head</span><Sha value={c.headSha} full /><AppliesTo sha={c.headSha} headSha={headSha} /></div>
            <div className={styles.factMeta}><span>base</span><Sha value={c.baseSha} copyable={false} /><span>observed <When iso={c.observedAt} /></span></div>
          </Fact>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function FixerClaimView({ claim, headSha }: { readonly claim: FixerClaim | null; readonly headSha: string | null }) {
  if (claim === null) {
    return <p className={shared.muted}>The read API does not provide the fixer's report for this case. The gate does not store it yet (backend requirement R3).</p>;
  }
  return (
    <div className={styles.claim}>
      <div className={styles.factHead}>
        <span className={styles.factTitle}>{claim.outcome === "fixed" ? "The fixer says it fixed the bug" : "The fixer says it could not reproduce the bug"}</span>
        <ProvenanceStamp source={claim.provenance} />
      </div>
      <p className={shared.muted}>This is the agent's own account. It is not verified by the console; rely on CI, the signed verifier and the gate.</p>
      <dl className={shared.dl}>
        <dt>Reported</dt><dd><When iso={claim.reportedAt} /></dd>
        <dt>Commit</dt><dd>{claim.headSha ? <><Sha value={claim.headSha} copyable={false} /> <AppliesTo sha={claim.headSha} headSha={headSha} /></> : "not stated"}</dd>
        <dt>Regression test</dt><dd>{claim.regressionTest ? <UntrustedText value={claim.regressionTest} /> : "not stated"}</dd>
        <dt>Tests run</dt><dd>{claim.testsRun.length > 0 ? <UntrustedText value={claim.testsRun.join(", ")} /> : "none listed"}</dd>
        <dt>Limitations</dt><dd>{claim.limitations.length > 0 ? <UntrustedText value={claim.limitations.join(" · ")} /> : "none listed"}</dd>
      </dl>
      {claim.summary ? <p className={styles.untrusted}><UntrustedText value={claim.summary} /></p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function Approvals({ approvals, headSha }: { readonly approvals: readonly Approval[]; readonly headSha: string | null }) {
  if (approvals.length === 0) return <p className={shared.muted}>No maintainer has approved or rejected this case.</p>;
  return (
    <ul className={styles.facts} aria-label="Maintainer decisions recorded by the gate">
      {approvals.map((a) => (
        <Fact key={a.id} stale={headSha !== null && a.headSha !== headSha} provenance={<ProvenanceStamp source={a.provenance} compact />}>
          <div className={styles.factHead}>
            <span className={styles.factTitle}>{a.decision === "approve" ? "Approved" : "Rejected"} by <span className={shared.mono}>{revealHidden(a.approverId, 256).text}</span></span>
            <When iso={a.createdAt} />
          </div>
          <div className={styles.factMeta}><Sha value={a.headSha} copyable={false} /><AppliesTo sha={a.headSha} headSha={headSha} /></div>
          {a.reason ? <p className={styles.untrusted}><UntrustedText value={a.reason} /></p> : null}
        </Fact>
      ))}
    </ul>
  );
}

const MERGE_STATUS: Readonly<Record<MergeOperation["status"], { status: Status; label: string }>> = {
  started: { status: "running", label: "Started" },
  succeeded: { status: "verified", label: "Merged" },
  failed: { status: "failed", label: "Failed" },
  unknown: { status: "unknown", label: "Outcome unknown" },
};

export function MergeOperations({ operations }: { readonly operations: readonly MergeOperation[] }) {
  if (operations.length === 0) return <p className={shared.muted}>The gate has not attempted a merge for this case.</p>;
  return (
    <ul className={styles.facts} aria-label="Merge attempts by the gate">
      {operations.map((m) => {
        const s = MERGE_STATUS[m.status];
        return (
          <Fact key={m.id} stale={false} provenance={<ProvenanceStamp source={m.provenance} compact />}>
            <div className={styles.factHead}>
              <span className={styles.factTitle}>Attempt {m.attempt}</span>
              <StatusIndicator status={s.status} label={s.label} />
              <When iso={m.startedAt} />
            </div>
            <div className={styles.factMeta}>
              <span>commit</span><Sha value={m.headSha} copyable={false} />
              {m.githubMergeSha ? <><span>merge commit</span><Sha value={m.githubMergeSha} copyable={false} /></> : null}
              {m.errorCode ? <span>{reasonLabel(m.errorCode)} ({m.errorCode})</span> : null}
            </div>
          </Fact>
        );
      })}
    </ul>
  );
}

export function evidenceCounts(c: CaseDetail) {
  return { evidence: c.ciChecks.length + c.verificationRuns.length, commits: c.commits.length, decisions: c.approvals.length + c.mergeOperations.length };
}
