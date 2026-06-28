import path from "node:path";
import { NpmAdapter } from "../adapters/npm/index.js";
import { bumpRange, editPackageJsonRange } from "../adapters/npm/range.js";
import type { UpdateCandidate } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { renderPrBody } from "./pr-body.js";
import { log } from "../logger.js";

export type UpdateType = UpdateCandidate["updateType"];

export interface UpdatePlan {
  candidate: UpdateCandidate;
  /** package.json path within the repo. */
  manifestPath: string;
  newRange: string;
  branch: string;
  title: string;
  body: string;
  /** Edited file content for the commit. */
  newContent: string;
  fileSha: string;
}

export interface PlanOptions {
  /** Which semver bump types to propose. Default: minor + patch. */
  allow: UpdateType[];
  /** Max number of PRs to plan in one run. */
  limit: number;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function branchName(c: UpdateCandidate): string {
  const scope = c.dir === "." ? "" : `${sanitize(c.dir)}-`;
  return `safebump/npm/${scope}${sanitize(c.name)}-${c.latestVersion}`;
}

/**
 * Build update plans for a remote repository (no local clone).
 * M0: one PR per dependency; range-only edit (lockfile resolution lands in M1).
 */
export async function planUpdates(
  gh: GitHubClient,
  ref: RepoRef,
  config: Config,
  opts: PlanOptions,
): Promise<{ base: string; plans: UpdatePlan[] }> {
  const base = await gh.getDefaultBranch(ref);
  const adapter = new NpmAdapter();

  const configuredDirs = config.ecosystems.npm.directories;
  const manifestPaths =
    configuredDirs.length > 0
      ? configuredDirs.map((d) => path.posix.join(d, "package.json"))
      : await gh.findManifestPaths(ref, base, "package.json");

  log.debug(`planning over ${manifestPaths.length} manifest(s) on ${base}`);

  const plans: UpdatePlan[] = [];

  for (const mPath of manifestPaths) {
    const file = await gh.getFile(ref, mPath, base);
    if (!file) continue;

    const repoRoot = ""; // remote paths are already repo-relative
    const manifest = adapter.parseManifestContent(file.content, mPath, repoRoot);
    const candidates = await adapter.listOutdated(manifest);

    for (const c of candidates) {
      if (!opts.allow.includes(c.updateType)) continue;
      if (plans.length >= opts.limit) break;

      const newRange = bumpRange(c.currentRange, c.latestVersion);
      let newContent: string;
      try {
        newContent = editPackageJsonRange(
          file.content,
          c.name,
          c.currentRange,
          newRange,
        );
      } catch (err) {
        log.warn(`skip ${c.name}: ${(err as Error).message}`);
        continue;
      }

      plans.push({
        candidate: c,
        manifestPath: mPath,
        newRange,
        branch: branchName(c),
        title: `bump ${c.name} from ${c.currentVersion ?? c.currentRange} to ${c.latestVersion}`,
        body: renderPrBody(c, newRange),
        newContent,
        fileSha: file.sha,
      });
    }
    if (plans.length >= opts.limit) break;
  }

  return { base, plans };
}
