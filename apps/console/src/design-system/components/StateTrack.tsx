import type { CaseState } from "@loopback/contracts";
import { STATE_LABELS, detourOf, isMainPathState, trackSteps, type MainPathState, type StepStatus } from "../../lib/lifecycle.ts";
import { isFullSha } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";
import { Badge } from "./Badge.tsx";
import { Sha } from "./Sha.tsx";
import { cx } from "./Button.tsx";
import styles from "./StateTrack.module.css";

/** Which party the case is waiting on in each main-path state (drives the current node's tone). */
const WAITING_ON: Readonly<Record<MainPathState, "machine" | "human" | "success">> = {
  Reported: "human", Triaged: "machine", FixInProgress: "machine", PRCreated: "machine", Verifying: "machine",
  AwaitingApproval: "human", ReadyToMerge: "human", Revalidating: "machine", Merging: "machine", Merged: "success",
};

const STATUS_TEXT: Readonly<Record<StepStatus, string>> = {
  done: "completed", current: "current step", upcoming: "not reached", invalidated: "evidence no longer applies (head moved)",
};

interface StateTrackProps {
  readonly state: CaseState;
  /** The PR's current head commit, as observed by the gate. */
  readonly headSha?: string | null;
  /** The commit the verification evidence is bound to (null when there is none). */
  readonly evidenceSha?: string | null;
}

/**
 * The Loop: a case's lifecycle over the 14 contract states, plus the commit seal. If the head moved away from
 * the commit the evidence was produced for, the seal breaks and evidence-dependent steps show as invalidated —
 * never as completed for the new commit.
 */
export function StateTrack({ state, headSha = null, evidenceSha = null }: StateTrackProps) {
  const headMoved = headSha !== null && evidenceSha !== null && headSha !== evidenceSha;
  const steps = trackSteps(state, headMoved);
  const detour = detourOf(state);
  const tone = detour ? detour.tone : isMainPathState(state) ? WAITING_ON[state] : "machine";
  return (
    <figure className={styles.track} aria-label={`Case lifecycle: ${STATE_LABELS[state]}`}>
      <div className={styles.summary}>
        <div className={styles.now}>
          <span className={styles.nowLabel}>State</span>
          <span className={styles.nowState}>{STATE_LABELS[state]}</span>
          {detour ? <Badge wrap tone={detour.tone} icon={detour.tone === "danger" ? "alert-triangle" : "refresh"}>{detour.meaning}</Badge> : null}
        </div>
      </div>
      <ol className={styles.steps}>
        {steps.map((step) => {
          const isDetourAnchor = detour?.from === step.state;
          return (
            <li key={step.state} className={cx(styles.step, step.status === "current" && styles[tone])} data-status={step.status} aria-current={step.status === "current" ? "step" : undefined}>
              <span className={styles.node} aria-hidden="true">
                {step.status === "done" ? <Icon name="check" size={13} /> : step.status === "invalidated" ? <Icon name="seal-broken" size={13} /> : step.status === "current" ? <Icon name="current" size={13} /> : null}
              </span>
              <span className={styles.name}>
                {STATE_LABELS[step.state]}
                <span className="visually-hidden"> — {STATUS_TEXT[step.status]}</span>
              </span>
              {isDetourAnchor && detour ? (
                <span className={styles.detour}><Badge tone={detour.tone} icon="alert-triangle">{STATE_LABELS[detour.state]}</Badge></span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {/* Keyed by variant: a change (e.g. the head moving while someone watches) mounts a new node, so a broken
          seal's alert is announced instead of silently flipping a role on a reused element. */}
      <Seal key={sealVariant(headSha, evidenceSha)} headSha={headSha} evidenceSha={evidenceSha} />
    </figure>
  );
}

type SealVariant = "no-head" | "no-evidence" | "broken" | "sealed";

function sealVariant(headSha: string | null, evidenceSha: string | null): SealVariant {
  if (headSha === null || !isFullSha(headSha)) return "no-head";
  if (evidenceSha === null) return "no-evidence";
  return headSha === evidenceSha ? "sealed" : "broken";
}

function Seal({ headSha, evidenceSha }: { readonly headSha: string | null; readonly evidenceSha: string | null }) {
  if (headSha === null || !isFullSha(headSha)) {
    return (
      <div className={styles.seal} role="note">
        <span className={styles.sealIcon}><Icon name="commit" size={16} /></span>
        <div className={styles.sealText}><span>No pull request head yet. Evidence will be bound to a full commit SHA.</span></div>
      </div>
    );
  }
  if (evidenceSha === null) {
    return (
      <div className={styles.seal} role="note">
        <span className={styles.sealIcon}><Icon name="commit" size={16} /></span>
        <div className={styles.sealText}>
          <span>Head commit — no verification evidence yet.</span>
          <span className={styles.shaLine}><Sha value={headSha} full /></span>
        </div>
      </div>
    );
  }
  if (headSha !== evidenceSha) {
    return (
      <div className={cx(styles.seal, styles.sealBroken)}>
        <span className={styles.sealIcon}><Icon name="seal-broken" size={16} /></span>
        <div className={styles.sealText}>
          {/* Short alert; the two full SHAs below stay ordinary content rather than being read out in the alert. */}
          <span role="alert"><strong>Seal broken: the head moved after verification.</strong> Verification must run again.</span>
          <span>Evidence was produced for the earlier commit and does not apply to the new head.</span>
          <span className={styles.shaLine}>Evidence for <Sha value={evidenceSha} full /></span>
          <span className={styles.shaLine}>Current head <Sha value={headSha} full /></span>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.seal} role="note">
      <span className={styles.sealIcon}><Icon name="seal" size={16} /></span>
      <div className={styles.sealText}>
        <strong>Sealed: evidence is bound to the current head.</strong>
        <span className={styles.shaLine}><Sha value={headSha} full /></span>
      </div>
    </div>
  );
}
