import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpRange } from "../adapters/npm/range.js";
import type { UpdateCandidate } from "../adapters/types.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { resolveUpdate } from "../resolve/ladder.js";
import { cleanupWorkdir } from "../resolve/workdir.js";
import type { ResolveOutcome } from "../resolve/types.js";
import { log } from "../logger.js";

const LOCK_FILES = ["package-lock.json", "npm-shrinkwrap.json"];

export interface CandidateResolution {
  candidate: UpdateCandidate;
  toRange: string;
  outcome: ResolveOutcome;
  /** Repo-relative file changes to commit (empty when unsolvable). */
  repoFiles: { path: string; content: string }[];
}

/** Fetch the manifest + lockfile for a dir from the base branch into a temp workdir. */
async function prepareRemoteWorkdir(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  dir: string,
): Promise<string> {
  const workdir = await mkdtemp(path.join(tmpdir(), "safebump-apply-"));
  const prefix = dir === "." ? "" : `${dir}/`;

  const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
  if (!pkg) throw new Error(`package.json not found in ${dir}`);
  await writeFile(path.join(workdir, "package.json"), pkg.content);

  // Fetch the first lockfile that exists; don't probe further (avoids 404s).
  for (const name of LOCK_FILES) {
    const lock = await gh.getFile(ref, `${prefix}${name}`, base);
    if (lock) {
      await writeFile(path.join(workdir, name), lock.content);
      break;
    }
  }
  return workdir;
}

/**
 * Resolve a single candidate against the live registry: fetch its manifest +
 * lockfile, run the F1 ladder (range bump → iterative co-bump), and return the
 * repo-relative file changes ready to commit.
 */
export async function resolveCandidate(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  const workdir = await prepareRemoteWorkdir(gh, ref, base, candidate.dir);
  const prefix = candidate.dir === "." ? "" : `${candidate.dir}/`;
  try {
    const fromRange = candidate.currentRange;
    const toRange = bumpRange(fromRange, candidate.latestVersion);
    log.debug(`resolving ${candidate.name} ${fromRange} → ${toRange} in ${candidate.dir}`);
    const outcome = await resolveUpdate({
      workdir,
      name: candidate.name,
      fromRange,
      toRange,
    });
    const repoFiles =
      outcome.status === "unsolvable"
        ? []
        : outcome.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content }));
    return { candidate, toRange, outcome, repoFiles };
  } finally {
    await cleanupWorkdir(workdir);
  }
}
