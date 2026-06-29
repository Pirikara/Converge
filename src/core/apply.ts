import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpRange } from "../adapters/npm/range.js";
import type { UpdateCandidate } from "../adapters/types.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { resolvePipUpdate } from "../resolve/pip.js";
import { getResolver } from "../resolve/npm-family.js";
import type { NpmPackageManager } from "../resolve/pm-detect.js";
import { cleanupWorkdir } from "../resolve/workdir.js";
import type { PackageChange } from "../resolve/types.js";
import { log } from "../logger.js";

/** Normalised resolution result across ecosystems. */
export interface CandidateResolution {
  candidate: UpdateCandidate;
  status: "resolved" | "resolved-cobump" | "unsolvable" | "needs-build";
  changes: PackageChange[];
  /** Repo-relative files to commit (empty unless resolved). */
  repoFiles: { path: string; content: string }[];
  /** Number of automatic co-bumps applied. */
  cobumps: number;
  /** Non-fatal warnings (e.g. pnpm unmet peers). */
  warnings: string[];
  /** Explanation for unsolvable / needs-build. */
  reason?: string;
}

async function resolveNpmFamily(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
  pm: NpmPackageManager,
): Promise<CandidateResolution> {
  const resolver = getResolver(pm);
  if (!resolver) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: `no resolver for ${pm}` };
  }
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "safebump-apply-"));
  try {
    const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
    if (!pkg) throw new Error(`package.json not found in ${dir}`);
    await writeFile(path.join(workdir, "package.json"), pkg.content);
    for (const name of resolver.lockfileNames) {
      const lock = await gh.getFile(ref, `${prefix}${name}`, base);
      if (lock) {
        await writeFile(path.join(workdir, name), lock.content);
        break;
      }
    }

    const fromRange = candidate.currentRange;
    const toRange = bumpRange(fromRange, candidate.latestVersion);
    const r = await resolver.resolve({ workdir, name: candidate.name, fromRange, toRange });

    if (r.status === "unsolvable") {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: r.warnings, reason: r.reason };
    }
    return {
      candidate,
      status: r.status,
      changes: r.changes,
      repoFiles: r.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
      cobumps: r.changes.filter((c) => c.cobump).length,
      warnings: r.warnings,
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolvePip(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  if (!candidate.currentVersion) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: "no pinned version to bump" };
  }
  const file = path.posix.basename(candidate.manifestPath); // requirements.txt
  const workdir = await mkdtemp(path.join(tmpdir(), "safebump-pip-"));
  try {
    const src = await gh.getFile(ref, candidate.manifestPath, base);
    if (!src) throw new Error(`${candidate.manifestPath} not found`);
    await writeFile(path.join(workdir, file), src.content);

    const outcome = await resolvePipUpdate({
      workdir,
      requirementsFile: file,
      name: candidate.name,
      fromPin: candidate.currentVersion,
      toVersion: candidate.latestVersion,
    });

    if (outcome.status === "resolved") {
      const edited = await readFile(path.join(workdir, file), "utf8");
      return {
        candidate,
        status: "resolved",
        changes: outcome.changes,
        repoFiles: [{ path: candidate.manifestPath, content: edited }],
        cobumps: 0,
        warnings: [],
      };
    }
    return {
      candidate,
      status: outcome.status === "needs-build" ? "needs-build" : "unsolvable",
      changes: outcome.changes,
      repoFiles: [],
      cobumps: 0,
      warnings: [],
      reason: outcome.reason,
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

/**
 * Resolve a candidate against the live registry, dispatching by ecosystem.
 * npm: package-lock-only ladder (+ co-bump); pip: uv compile (--no-build).
 * No package code is executed in either path.
 */
export async function resolveCandidate(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
  pm: NpmPackageManager = "npm",
): Promise<CandidateResolution> {
  log.debug(`resolving ${candidate.ecosystem} ${candidate.name} in ${candidate.dir} (pm=${pm})`);
  return candidate.ecosystem === "pip"
    ? resolvePip(gh, ref, base, candidate)
    : resolveNpmFamily(gh, ref, base, candidate, pm);
}
