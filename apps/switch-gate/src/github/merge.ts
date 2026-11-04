import { GitHubError, HeadChanged, NotMergeable, Uncertain, type GitHubTransport } from "./transport.js";

/**
 * The only merge call in the codebase (invariant 1). Lint restricts imports of
 * this module to cases/service.ts. Always sends GitHub's `sha` precondition so
 * GitHub itself refuses if the head moved (409). Never retried.
 */
export async function mergePullRequest(
  t: GitHubTransport,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<{ merged: boolean; sha: string | null }> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new GitHubError("merge requires a full head SHA", null);
  const res = await t.write("PUT", `/repos/${repo}/pulls/${prNumber}/merge`, { sha: headSha, merge_method: "squash" });
  if (res.status === 200) {
    const body = res.body as { merged?: unknown; sha?: unknown } | null;
    return { merged: body?.merged === true, sha: typeof body?.sha === "string" ? body.sha : null };
  }
  if (res.status === 409) throw new HeadChanged("head changed: GitHub refused the sha precondition", 409);
  if (res.status === 405) throw new NotMergeable("GitHub reports the PR is not mergeable", 405);
  if (res.status >= 500) throw new Uncertain(`merge returned ${res.status}`, res.status);
  throw new GitHubError(`merge returned ${res.status}`, res.status);
}

/** A merge capability bound to one transport and repository, injected by main.ts. */
export type Merger = (prNumber: number, headSha: string) => Promise<{ merged: boolean; sha: string | null }>;

export function createMerger(t: GitHubTransport, repo: string): Merger {
  return (prNumber, headSha) => mergePullRequest(t, repo, prNumber, headSha);
}
