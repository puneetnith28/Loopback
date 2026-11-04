import { createHash, type KeyObject } from "node:crypto";
import { VerifierReport } from "@loopback/contracts";
import { z } from "zod";
import { verifyCapability } from "../agents/capability.js";
import { signReport, signedBytes } from "../agents/signature.js";

/**
 * D29: the verifier signer's decision, independent of transport. A signature is issued only for
 * a schema-valid, unsigned verifier report whose digest matches; that is bound to a gate-issued,
 * unexpired capability naming the same run, case, repository, PR and full head SHA; whose
 * repository this signer serves; whose PR is open at exactly that head on GitHub now; and only
 * once per run (the run is claimed atomically before signing). Every failure signs nothing.
 *
 * What a signature from this signer proves: the report was accepted at this boundary for a run
 * the gate issued and a head that was live at signing time. It does not prove that the tests
 * were run or that the verdict is true (D28/D29 residuals, docs/threat-model.md).
 */

export interface LivePull { readonly state: "open" | "closed"; readonly headSha: string }

export interface ReplayStore {
  /** Atomically record that `runId` was signed. False if it already was. Throws on I/O failure. */
  claim(runId: string, reportDigest: string): boolean;
}

export interface SignerPolicyDeps {
  readonly issuerPublicKey: KeyObject;
  readonly signingKey: KeyObject;
  /** The single repository this signer serves ("owner/name"). */
  readonly allowedRepository: string;
  readonly now: () => Date;
  /** Reads the PR from GitHub now. Throws when GitHub cannot be read. */
  readonly livePull: (repository: string, pullRequest: number) => Promise<LivePull>;
  readonly replay: ReplayStore;
}

export type SignErrorCode =
  | "MALFORMED" | "REPORT_INVALID" | "DIGEST_MISMATCH" | "CAPABILITY_INVALID" | "CAPABILITY_EXPIRED" | "CONTEXT_MISMATCH"
  | "REPOSITORY_NOT_ALLOWED" | "STALE_HEAD" | "PR_NOT_OPEN" | "CONTEXT_UNAVAILABLE" | "REPLAYED" | "INTERNAL";

export type SignDecision =
  | { readonly ok: true; readonly signature: string; readonly reportDigest: string; readonly runId: string }
  | { readonly ok: false; readonly code: SignErrorCode; readonly status: number };

const SignRequest = z.object({
  capability: z.string().min(1).max(2048),
  report: z.unknown(),
  reportDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

/** The digest that binds a request to one exact report: SHA-256 over the canonical signed bytes. */
export function reportDigest(report: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(signedBytes(report)).digest("hex")}`;
}

const deny = (code: SignErrorCode, status: number): SignDecision => ({ ok: false, code, status });

export async function evaluateSignRequest(body: unknown, d: SignerPolicyDeps): Promise<SignDecision> {
  const req = SignRequest.safeParse(body);
  if (!req.success) return deny("MALFORMED", 400);
  const parsed = VerifierReport.safeParse(req.data.report);
  if (!parsed.success || parsed.data.signature !== undefined) return deny("REPORT_INVALID", 400);
  const report = parsed.data;
  const digest = reportDigest(report);
  if (digest !== req.data.reportDigest) return deny("DIGEST_MISMATCH", 400);

  const cap = verifyCapability(req.data.capability, d.issuerPublicKey, d.now());
  if (!cap.ok) return deny(cap.reason === "expired" ? "CAPABILITY_EXPIRED" : "CAPABILITY_INVALID", 403);
  const c = cap.capability;
  if (c.runId !== report.runId || c.caseId !== report.caseId || c.repository !== report.repository
    || c.pullRequest !== report.pullRequest || c.headSha !== report.headSha) {
    return deny("CONTEXT_MISMATCH", 403);
  }
  if (report.repository !== d.allowedRepository) return deny("REPOSITORY_NOT_ALLOWED", 403);

  let live: LivePull;
  try {
    live = await d.livePull(report.repository, report.pullRequest);
  } catch {
    return deny("CONTEXT_UNAVAILABLE", 503);
  }
  if (live.state !== "open") return deny("PR_NOT_OPEN", 409);
  if (live.headSha !== report.headSha) return deny("STALE_HEAD", 409);

  try {
    if (!d.replay.claim(report.runId, digest)) return deny("REPLAYED", 409);
  } catch {
    return deny("INTERNAL", 500);
  }
  return { ok: true, signature: signReport(report, d.signingKey), reportDigest: digest, runId: report.runId };
}
