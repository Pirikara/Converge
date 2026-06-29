import { parseLockfile } from "../audit/lockfiles.js";
import { auditPackages, type AuditFinding } from "../audit/audit.js";
import type { LockPackage } from "../audit/lockfile-npm.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import type { CandidateResolution } from "./apply.js";
import { log } from "../logger.js";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "go.sum",
  "Gemfile.lock",
]);

/** Packages present in `next` but not in `prev` (added or version-changed). */
export function computeDelta(prev: LockPackage[], next: LockPackage[]): LockPackage[] {
  const prevSet = new Set(prev.map((p) => `${p.name}@${p.version}`));
  return next.filter((p) => !prevSet.has(`${p.name}@${p.version}`));
}

/**
 * Audit what an update *introduces* into the transitive tree: diff the
 * regenerated lockfile against the base, then OSV-check only the newly added /
 * version-changed packages. Surfaces malware/vulns a PR would pull in
 * transitively — something direct-only tools never check.
 */
export async function auditIntroduced(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  res: CandidateResolution,
): Promise<AuditFinding[]> {
  const newFile = res.repoFiles.find((f) => LOCKFILE_NAMES.has(f.path.split("/").pop() ?? ""));
  if (!newFile) return []; // e.g. pip (requirements.txt only)

  const parsedNew = parseLockfile(newFile.path, newFile.content);
  if (!parsedNew) return [];

  const old = await gh.getFile(ref, newFile.path, base);
  const prevTree = old ? (parseLockfile(newFile.path, old.content)?.packages ?? []) : [];
  const delta = computeDelta(prevTree, parsedNew.packages);
  if (delta.length === 0) return [];

  log.debug(`update introduces ${delta.length} new/changed transitive package(s)`);
  return auditPackages(parsedNew.ecosystem, delta, new Set());
}
