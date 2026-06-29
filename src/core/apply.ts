import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpRange } from "../adapters/npm/range.js";
import type { UpdateCandidate } from "../adapters/types.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { resolveUpdate } from "../resolve/ladder.js";
import { resolvePipUpdate } from "../resolve/pip.js";
import { cleanupWorkdir } from "../resolve/workdir.js";
import type { PackageChange } from "../resolve/types.js";
import { log } from "../logger.js";

const LOCK_FILES = ["package-lock.json", "npm-shrinkwrap.json"];

/** Normalised resolution result across ecosystems. */
export interface CandidateResolution {
  candidate: UpdateCandidate;
  status: "resolved" | "resolved-cobump" | "unsolvable" | "needs-build";
  changes: PackageChange[];
  /** Repo-relative files to commit (empty unless resolved). */
  repoFiles: { path: string; content: string }[];
  /** Number of automatic co-bumps applied. */
  cobumps: number;
  /** Explanation for unsolvable / needs-build. */
  reason?: string;
}

async function resolveNpm(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "safebump-apply-"));
  try {
    const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
    if (!pkg) throw new Error(`package.json not found in ${dir}`);
    await writeFile(path.join(workdir, "package.json"), pkg.content);
    for (const name of LOCK_FILES) {
      const lock = await gh.getFile(ref, `${prefix}${name}`, base);
      if (lock) {
        await writeFile(path.join(workdir, name), lock.content);
        break;
      }
    }

    const fromRange = candidate.currentRange;
    const toRange = bumpRange(fromRange, candidate.latestVersion);
    const outcome = await resolveUpdate({ workdir, name: candidate.name, fromRange, toRange });

    if (outcome.status === "unsolvable") {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, reason: outcome.reason };
    }
    return {
      candidate,
      status: outcome.status,
      changes: outcome.changes,
      repoFiles: outcome.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
      cobumps: outcome.changes.filter((c) => c.cobump).length,
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
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, reason: "no pinned version to bump" };
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
      };
    }
    return {
      candidate,
      status: outcome.status === "needs-build" ? "needs-build" : "unsolvable",
      changes: outcome.changes,
      repoFiles: [],
      cobumps: 0,
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
): Promise<CandidateResolution> {
  log.debug(`resolving ${candidate.ecosystem} ${candidate.name} in ${candidate.dir}`);
  return candidate.ecosystem === "pip"
    ? resolvePip(gh, ref, base, candidate)
    : resolveNpm(gh, ref, base, candidate);
}
