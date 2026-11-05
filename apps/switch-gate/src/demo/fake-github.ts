import type { CheckRunDetails, GitHubReader, PullDetails } from "../github/client.js";
import type { BaseProtection, LiveSnapshot } from "../policy/evaluate.js";

/**
 * A stand-in GitHub for the rehearsal (`npm run demo`), so it runs with no accounts. It holds the
 * state a real repository would and answers the same questions; it does not imitate GitHub's own
 * rules, which docs/evidence/phase-06-ruleset-proof.md proves on the real thing.
 */
export class RehearsalGitHub implements GitHubReader {
  readonly statuses: { sha: string; state: string; description: string }[] = [];
  private readonly pulls = new Map<number, PullDetails>();
  private readonly checks = new Map<string, CheckRunDetails[]>();
  private readonly protection: BaseProtection = {
    requiredStatusChecks: [{ context: "test", integrationId: 1 }, { context: "loopback/gate", integrationId: 100 }],
    requiresPullRequest: true, requiresUpToDate: true, blocksForcePush: true, restrictsDeletion: true,
  };

  constructor(private readonly repo: string, private readonly baseBranch: string, private readonly baseSha: string) {}

  openPull(number: number, headRef: string, headSha: string): void {
    this.pulls.set(number, {
      number, state: "open", draft: false, merged: false, mergeable: true, headSha, headRef,
      headRepo: this.repo, baseRef: this.baseBranch, baseSha: this.baseSha, mergeCommitSha: null,
    });
  }

  /** Someone pushes another commit to the PR's branch. */
  pushCommit(number: number, headSha: string): void {
    this.pulls.set(number, { ...this.require(number), headSha });
  }

  finishCi(sha: string, id: number): void {
    this.checks.set(sha, [{ id, name: "test", appSlug: "github-actions", status: "completed", conclusion: "success", headSha: sha, htmlUrl: "" }]);
  }

  markMerged(number: number, mergeCommitSha: string): void {
    this.pulls.set(number, { ...this.require(number), merged: true, state: "closed", mergeCommitSha });
  }

  private require(number: number): PullDetails {
    const p = this.pulls.get(number);
    if (!p) throw new Error(`no pull request #${number}`);
    return p;
  }

  getPull(n: number): Promise<PullDetails> {
    return Promise.resolve({ ...this.require(n) });
  }
  findOpenPullByBranch(branch: string): Promise<PullDetails | undefined> {
    return Promise.resolve([...this.pulls.values()].find((p) => p.headRef === branch && p.state === "open"));
  }
  listCheckRuns(sha: string): Promise<CheckRunDetails[]> {
    return Promise.resolve(this.checks.get(sha) ?? []);
  }
  listPullFiles(): Promise<string[]> {
    return Promise.resolve(["src/format.js", "test/format.test.js"]);
  }
  getBranchRules(): Promise<BaseProtection> {
    return Promise.resolve(this.protection);
  }
  getBranchHead(): Promise<string> {
    return Promise.resolve(this.baseSha);
  }
  setGateStatus(sha: string, state: "success" | "failure" | "pending" | "error", description: string): Promise<void> {
    this.statuses.push({ sha, state, description });
    return Promise.resolve();
  }
  async snapshot(n: number): Promise<{ snapshot: LiveSnapshot; pull: PullDetails | undefined }> {
    const pull = await this.getPull(n);
    return {
      pull,
      snapshot: {
        repo: this.repo, prNumber: n, pr: pull, checks: await this.listCheckRuns(pull.headSha),
        baseProtection: this.protection, changedFiles: await this.listPullFiles(), changedFilesHeadSha: pull.headSha,
      },
    };
  }
}
