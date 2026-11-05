/** Where a fact comes from, and how far it can be trusted (DESIGN.md §2). */
export const PROVENANCE_KINDS = ["github", "gate", "signed-verifier", "agent-claim", "demo"] as const;
export type Provenance = (typeof PROVENANCE_KINDS)[number];

export interface ProvenanceMeta {
  readonly label: string;
  /** One-line meaning, used as the accessible description. */
  readonly description: string;
  /** Trust category, always shown as text (never colour alone). */
  readonly trust: "observed" | "decided" | "signed" | "unverified" | "demo";
  readonly trustLabel: string;
}

export const PROVENANCE: Readonly<Record<Provenance, ProvenanceMeta>> = {
  github: { label: "GitHub", description: "Observed by the gate on GitHub", trust: "observed", trustLabel: "Observed" },
  gate: { label: "Gate", description: "Policy decision recorded by the gatekeeper", trust: "decided", trustLabel: "Decided" },
  "signed-verifier": { label: "Signed verifier", description: "Verifier evidence with a valid Ed25519 signature", trust: "signed", trustLabel: "Signed" },
  "agent-claim": { label: "Agent claim", description: "Reported by an agent and not independently verified", trust: "unverified", trustLabel: "Unverified" },
  demo: { label: "DEMO", description: "Demonstration fixture, not real data", trust: "demo", trustLabel: "Fixture" },
};
