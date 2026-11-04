import type { BaseProtection, LiveCheck, LivePull, LiveSnapshot } from "../policy/evaluate.js";
import { GitHubError, RateLimited, Uncertain, type GitHubTransport } from "./transport.js";

export { GitHubError, HeadChanged, NotMergeable, RateLimited, Uncertain } from "./transport.js";

/** GitHub caps the PR files list; a list this long may be truncated and must not be trusted. */
export const MAX_PR_FILES = 3000;

export interface PullDetails extends LivePull {
  readonly number: number;
  readonly mergeCommitSha: string | null;
  readonly baseSha: string;
}

export interface CheckRunDetails extends LiveCheck {
  readonly htmlUrl: string;
}

/** Read and status operations the gate needs. Merging lives in github/merge.ts. */
export interface GitHubReader {
  getPull(n: number): Promise<PullDetails>;
  findOpenPullByBranch(branch: string): Promise<PullDetails | undefined>;
  listCheckRuns(sha: string): Promise<CheckRunDetails[]>;
  listPullFiles(n: number): Promise<string[] | undefined>;
  getBranchRules(branch: string): Promise<BaseProtection>;
  getBranchHead(branch: string): Promise<string>;
  setGateStatus(sha: string, state: "success" | "failure" | "pending" | "error", description: string): Promise<void>;
  snapshot(n: number): Promise<{ snapshot: LiveSnapshot; pull: PullDetails | undefined }>;
}

interface RawPull {
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}

const enc = encodeURIComponent;

export class GitHubClient implements GitHubReader {
  readonly repo: string;
  private readonly owner: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly t: GitHubTransport,
    repo: string,
    private readonly statusContext: string,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.repo = repo;
    this.owner = repo.split("/")[0]!;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private path(p: string): string {
    return `/repos/${this.repo}${p}`;
  }

  private toPull(r: RawPull): PullDetails {
    return {
      number: r.number,
      state: r.state === "open" ? "open" : "closed",
      draft: r.draft === true,
      merged: r.merged === true,
      mergeable: r.mergeable === true ? true : r.mergeable === false ? false : null,
      headSha: r.head.sha,
      headRef: r.head.ref,
      headRepo: r.head.repo?.full_name ?? null,
      baseRef: r.base.ref,
      baseSha: r.base.sha,
      mergeCommitSha: r.merge_commit_sha ?? null,
    };
  }

  /** GitHub computes mergeability lazily; retry once when it is still null (§10.7). */
  async getPull(n: number): Promise<PullDetails> {
    let pull = this.toPull((await this.t.getJson<RawPull>(this.path(`/pulls/${n}`))).body);
    if (pull.mergeable === null && pull.state === "open" && !pull.merged) {
      await this.sleep(1500);
      pull = this.toPull((await this.t.getJson<RawPull>(this.path(`/pulls/${n}`))).body);
    }
    return pull;
  }

  async findOpenPullByBranch(branch: string): Promise<PullDetails | undefined> {
    const { body } = await this.t.getJson<RawPull[]>(this.path(`/pulls?head=${enc(`${this.owner}:${branch}`)}&state=open&per_page=10`));
    if (body.length > 1) throw new GitHubError(`more than one open PR for ${branch}`, null);
    return body[0] ? this.toPull(body[0]) : undefined;
  }

  async listCheckRuns(sha: string): Promise<CheckRunDetails[]> {
    const out: CheckRunDetails[] = [];
    for (let page = 1; page <= 10; page++) {
      const { body } = await this.t.getJson<{ total_count: number; check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; head_sha: string; html_url: string; app: { slug: string } | null }> }>(
        this.path(`/commits/${enc(sha)}/check-runs?per_page=100&page=${page}`),
      );
      for (const r of body.check_runs) {
        out.push({ id: r.id, name: r.name, appSlug: r.app?.slug ?? "", status: r.status, conclusion: r.conclusion, headSha: r.head_sha, htmlUrl: r.html_url });
      }
      if (out.length >= body.total_count || body.check_runs.length === 0) return out;
    }
    throw new GitHubError("too many check runs to evaluate", null);
  }

  /** Changed files including previous names of renames; undefined if possibly truncated. */
  async listPullFiles(n: number): Promise<string[] | undefined> {
    const files: string[] = [];
    let seen = 0;
    for (let page = 1; page <= 30; page++) {
      const { body } = await this.t.getJson<Array<{ filename: string; previous_filename?: string }>>(this.path(`/pulls/${n}/files?per_page=100&page=${page}`));
      for (const f of body) {
        files.push(f.filename);
        if (f.previous_filename) files.push(f.previous_filename);
      }
      seen += body.length;
      if (body.length < 100) return seen >= MAX_PR_FILES ? undefined : files;
    }
    return undefined;
  }

  /** Active rules that apply to a branch (rulesets). Fields GitHub does not expose stay unverified here. */
  async getBranchRules(branch: string): Promise<BaseProtection> {
    const rules: Array<{ type: string; parameters?: Record<string, unknown> }> = [];
    for (let page = 1; page <= 10; page++) {
      const { body } = await this.t.getJson<Array<{ type: string; parameters?: Record<string, unknown> }>>(this.path(`/rules/branches/${enc(branch)}?per_page=100&page=${page}`));
      rules.push(...body);
      if (body.length < 100) break;
    }
    const contexts: string[] = [];
    let strict = false;
    for (const r of rules.filter((x) => x.type === "required_status_checks")) {
      const p = r.parameters ?? {};
      const checks = Array.isArray(p.required_status_checks) ? p.required_status_checks : [];
      for (const c of checks) if (c && typeof (c as { context?: unknown }).context === "string") contexts.push((c as { context: string }).context);
      if (p.strict_required_status_checks_policy === true) strict = true;
    }
    return {
      requiredStatusContexts: contexts,
      requiresUpToDate: strict,
      requiresPullRequest: rules.some((r) => r.type === "pull_request"),
      blocksForcePush: rules.some((r) => r.type === "non_fast_forward"),
      restrictsDeletion: rules.some((r) => r.type === "deletion"),
    };
  }

  async getBranchHead(branch: string): Promise<string> {
    const { body } = await this.t.getJson<{ commit: { sha: string } }>(this.path(`/branches/${enc(branch)}`));
    return body.commit.sha;
  }

  async setGateStatus(sha: string, state: "success" | "failure" | "pending" | "error", description: string): Promise<void> {
    const res = await this.t.write("POST", this.path(`/statuses/${enc(sha)}`), {
      state, context: this.statusContext, description: description.slice(0, 140),
    });
    if (res.status !== 201) throw new GitHubError(`setting commit status returned ${res.status}`, res.status);
  }

  /**
   * Live snapshot for policy evaluation. The head is read before and after the
   * other reads; if it moved, the file list is bound to the old head and policy
   * blocks. Any read failure yields undefined fields (policy then blocks).
   * Rate limits propagate so the caller can report RATE_LIMITED.
   */
  async snapshot(n: number): Promise<{ snapshot: LiveSnapshot; pull: PullDetails | undefined }> {
    const empty = (): LiveSnapshot => ({
      repo: this.repo, prNumber: n, pr: undefined, checks: undefined, baseProtection: undefined,
      changedFiles: undefined, changedFilesHeadSha: undefined,
    });
    try {
      const before = await this.getPull(n);
      const [checks, files, rules] = await Promise.all([
        this.listCheckRuns(before.headSha),
        this.listPullFiles(n),
        this.getBranchRules(before.baseRef),
      ]);
      const after = await this.getPull(n);
      return {
        pull: after,
        snapshot: {
          repo: this.repo, prNumber: n, pr: after, checks, baseProtection: rules,
          changedFiles: files,
          // A head or base change between the reads leaves the snapshot inconsistent: policy blocks.
          changedFilesHeadSha: before.baseRef === after.baseRef ? before.headSha : undefined,
        },
      };
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      if (e instanceof GitHubError || e instanceof Uncertain) return { snapshot: empty(), pull: undefined };
      throw e;
    }
  }
}
