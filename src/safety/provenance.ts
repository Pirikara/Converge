import semver from "semver";
import type { PackageMeta } from "../adapters/types.js";

export interface ProvenanceStatus {
  /** The target version was published with provenance. */
  targetHasProvenance: boolean;
  /** A trusted baseline version had provenance (current or the predecessor). */
  baselineHadProvenance: boolean;
  /** The baseline version used for comparison, when one established provenance. */
  baselineVersion?: string;
}

/** Highest stable published version strictly below `target`. */
function predecessorOf(meta: PackageMeta, target: string): string | undefined {
  const below = meta.versions
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.lt(v, target))
    .sort(semver.rcompare);
  return below[0];
}

/**
 * Determine whether upgrading to `targetVersion` would lose npm provenance that
 * the package had already established — the F2.2 supply-chain signal we trust.
 *
 * Baseline = the version currently in use, or (if that lacked provenance) the
 * published version immediately preceding the target. A hijacked release that
 * skips the project's trusted CI typically drops provenance, so a downgrade
 * relative to a provenance baseline is suspicious.
 */
export function provenanceStatus(
  meta: PackageMeta,
  currentVersion: string | null,
  targetVersion: string,
): ProvenanceStatus {
  const targetHasProvenance = meta.provenance[targetVersion] === true;

  let baselineVersion: string | undefined;
  if (currentVersion && meta.provenance[currentVersion]) {
    baselineVersion = currentVersion;
  } else {
    const pred = predecessorOf(meta, targetVersion);
    if (pred && meta.provenance[pred]) baselineVersion = pred;
  }

  return {
    targetHasProvenance,
    baselineHadProvenance: baselineVersion != null,
    baselineVersion,
  };
}
