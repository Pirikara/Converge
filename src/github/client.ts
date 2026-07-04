import { Octokit } from "@octokit/rest";
import { log } from "../logger.js";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse "owner/repo" or a GitHub URL into a RepoRef. */
export function parseRepoRef(input: string): RepoRef {
  const url = input.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (url) return { owner: url[1]!, repo: url[2]! };
  const slug = input.match(/^([^/]+)\/([^/]+)$/);
  if (slug) return { owner: slug[1]!, repo: slug[2]!.replace(/\.git$/, "") };
  throw new Error(`invalid repo reference: ${input} (expected owner/repo)`);
}

export function resolveToken(explicit?: string): string {
  const token =
    explicit ??
    process.env.CONVERGE_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "no GitHub token found (set CONVERGE_TOKEN or GITHUB_TOKEN, or pass --token)",
    );
  }
  return token;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    // Route Octokit's internal request logs to our debug channel so expected
    // 404s (e.g. missing converge.json) don't surface as warnings.
    this.octokit = new Octokit({
      auth: token,
      userAgent: "converge",
      log: {
        debug: (m: string) => log.debug(m),
        info: (m: string) => log.debug(m),
        warn: (m: string) => log.debug(m),
        error: (m: string) => log.debug(m),
      },
    });
  }

  async getDefaultBranch(ref: RepoRef): Promise<string> {
    const { data } = await this.octokit.repos.get({ ...ref });
    return data.default_branch;
  }

  /** Download the repo source as a gzip'd tarball at a ref (for `go mod tidy`). */
  async downloadTarball(ref: RepoRef, branch: string): Promise<Buffer> {
    const { data } = await this.octokit.repos.downloadTarballArchive({ ...ref, ref: branch });
    return Buffer.from(data as ArrayBuffer);
  }

  /** Returns file text + blob sha at a ref, or null if absent. */
  async getFile(
    ref: RepoRef,
    path: string,
    branch: string,
  ): Promise<{ content: string; sha: string } | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        ...ref,
        path,
        ref: branch,
      });
      if (Array.isArray(data) || data.type !== "file") return null;
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { content, sha: data.sha };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** List paths of files named `filename` across the repo tree at `branch`. */
  async findManifestPaths(
    ref: RepoRef,
    branch: string,
    filename: string,
  ): Promise<string[]> {
    return this.findManifestPathsMatching(ref, branch, (p) => p.split("/").pop() === filename);
  }

  /**
   * List repo paths at `branch` whose path matches `predicate`. Generalizes
   * basename matching for manifests identified by location (e.g. Actions
   * workflows under `.github/workflows/`).
   */
  async findManifestPathsMatching(
    ref: RepoRef,
    branch: string,
    predicate: (path: string) => boolean,
  ): Promise<string[]> {
    const { data } = await this.octokit.git.getTree({
      ...ref,
      tree_sha: branch,
      recursive: "true",
    });
    return data.tree
      .filter(
        (e) =>
          e.type === "blob" &&
          typeof e.path === "string" &&
          !e.path.split("/").includes("node_modules") &&
          predicate(e.path),
      )
      .map((e) => e.path as string)
      .sort();
  }

  /**
   * Fetch source files under `dirPrefix` matching `predicate`, capped at `cap`
   * files, via the tree + blob API. Skips node_modules and oversized blobs.
   */
  async fetchSourceFiles(
    ref: RepoRef,
    branch: string,
    opts: { dirPrefix: string; predicate: (path: string) => boolean; cap: number },
  ): Promise<{ path: string; content: string }[]> {
    const { data } = await this.octokit.git.getTree({
      ...ref,
      tree_sha: branch,
      recursive: "true",
    });
    const prefix = opts.dirPrefix === "." ? "" : `${opts.dirPrefix.replace(/\/$/, "")}/`;
    const blobs = data.tree
      .filter(
        (e) =>
          e.type === "blob" &&
          typeof e.path === "string" &&
          e.path.startsWith(prefix) &&
          !e.path.split("/").includes("node_modules") &&
          opts.predicate(e.path) &&
          (e.size ?? 0) < 1_000_000,
      )
      .slice(0, opts.cap);

    const out: { path: string; content: string }[] = [];
    const concurrency = 8;
    for (let i = 0; i < blobs.length; i += concurrency) {
      const batch = blobs.slice(i, i + concurrency);
      const fetched = await Promise.all(
        batch.map(async (b) => {
          const blob = await this.octokit.git.getBlob({ ...ref, file_sha: b.sha! });
          const content = Buffer.from(blob.data.content, "base64").toString("utf8");
          return { path: b.path as string, content };
        }),
      );
      out.push(...fetched);
    }
    return out;
  }

  async getBranchSha(ref: RepoRef, branch: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({
      ...ref,
      ref: `heads/${branch}`,
    });
    return data.object.sha;
  }

  async branchExists(ref: RepoRef, branch: string): Promise<boolean> {
    try {
      await this.octokit.git.getRef({ ...ref, ref: `heads/${branch}` });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }

  async createBranch(
    ref: RepoRef,
    branch: string,
    fromSha: string,
  ): Promise<void> {
    await this.octokit.git.createRef({
      ...ref,
      ref: `refs/heads/${branch}`,
      sha: fromSha,
    });
    log.debug(`created branch ${branch}`);
  }

  /** Create or update a file on a branch, returning the new commit sha. */
  async putFile(
    ref: RepoRef,
    params: {
      path: string;
      content: string;
      branch: string;
      message: string;
      sha?: string;
    },
  ): Promise<string> {
    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      ...ref,
      path: params.path,
      message: params.message,
      content: Buffer.from(params.content, "utf8").toString("base64"),
      branch: params.branch,
      sha: params.sha,
    });
    return data.commit.sha ?? "";
  }

  /**
   * Create a single commit containing multiple file changes on a new branch,
   * branched from `baseSha`. Returns the new commit sha.
   */
  async commitFiles(
    ref: RepoRef,
    params: {
      branch: string;
      baseSha: string;
      message: string;
      files: { path: string; content: string }[];
    },
  ): Promise<string> {
    const baseCommit = await this.octokit.git.getCommit({
      ...ref,
      commit_sha: params.baseSha,
    });
    const tree = await this.octokit.git.createTree({
      ...ref,
      base_tree: baseCommit.data.tree.sha,
      tree: params.files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
      })),
    });
    const commit = await this.octokit.git.createCommit({
      ...ref,
      message: params.message,
      tree: tree.data.sha,
      parents: [params.baseSha],
    });
    // Upsert the branch: create it, or force-move an existing one to the new
    // commit (so a stream branch is refreshed to the latest target in place).
    try {
      await this.octokit.git.createRef({
        ...ref,
        ref: `refs/heads/${params.branch}`,
        sha: commit.data.sha,
      });
    } catch {
      await this.octokit.git.updateRef({
        ...ref,
        ref: `heads/${params.branch}`,
        sha: commit.data.sha,
        force: true,
      });
    }
    log.debug(`committed ${params.files.length} file(s) to ${params.branch}`);
    return commit.data.sha;
  }

  /** Find an open PR whose head branch matches, if any (with its title). */
  async findOpenPr(ref: RepoRef, head: string): Promise<{ number: number; title: string } | null> {
    const { data } = await this.octokit.pulls.list({
      ...ref,
      state: "open",
      head: `${ref.owner}:${head}`,
    });
    const pr = data[0];
    return pr ? { number: pr.number, title: pr.title } : null;
  }

  async createPr(
    ref: RepoRef,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const { data } = await this.octokit.pulls.create({
      ...ref,
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body,
    });
    return { number: data.number, url: data.html_url };
  }

  /** Update an existing PR's title + body (used to refresh a stream PR). */
  async updatePr(
    ref: RepoRef,
    number: number,
    params: { title: string; body: string },
  ): Promise<void> {
    await this.octokit.pulls.update({
      ...ref,
      pull_number: number,
      title: params.title,
      body: params.body,
    });
  }

  /**
   * How far `branch` is ahead of / behind `base`. `behind > 0` = base moved;
   * `ahead > 1` = extra commits (a Converge branch is always exactly 1 ahead, so
   * more means a human pushed to it).
   */
  async compareBranch(
    ref: RepoRef,
    base: string,
    branch: string,
  ): Promise<{ ahead: number; behind: number }> {
    try {
      const { data } = await this.octokit.repos.compareCommitsWithBasehead({
        ...ref,
        basehead: `${base}...${branch}`,
      });
      return { ahead: data.ahead_by, behind: data.behind_by };
    } catch {
      return { ahead: 1, behind: 0 }; // compare unavailable → treat as own & current
    }
  }

  /**
   * Whether a PR actually conflicts with its base. GitHub computes mergeability
   * asynchronously, so retry a few times while it's `unknown`; if still unknown,
   * report false (the next run will catch it once GitHub has computed it).
   */
  async prConflicting(ref: RepoRef, number: number): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      const { data } = await this.octokit.pulls.get({ ...ref, pull_number: number });
      const state = data.mergeable_state;
      if (state && state !== "unknown") return state === "dirty";
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }
}
