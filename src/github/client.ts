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
    process.env.SAFEBUMP_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "no GitHub token found (set SAFEBUMP_TOKEN or GITHUB_TOKEN, or pass --token)",
    );
  }
  return token;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    // Route Octokit's internal request logs to our debug channel so expected
    // 404s (e.g. missing safebump.json) don't surface as warnings.
    this.octokit = new Octokit({
      auth: token,
      userAgent: "safebump",
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
          e.path.split("/").pop() === filename &&
          !e.path.split("/").includes("node_modules"),
      )
      .map((e) => e.path as string)
      .sort();
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
    await this.octokit.git.createRef({
      ...ref,
      ref: `refs/heads/${params.branch}`,
      sha: commit.data.sha,
    });
    log.debug(`committed ${params.files.length} file(s) to ${params.branch}`);
    return commit.data.sha;
  }

  /** Find an open PR whose head branch matches, if any. */
  async findOpenPr(ref: RepoRef, head: string): Promise<number | null> {
    const { data } = await this.octokit.pulls.list({
      ...ref,
      state: "open",
      head: `${ref.owner}:${head}`,
    });
    return data[0]?.number ?? null;
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
}
