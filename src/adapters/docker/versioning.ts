import semver from "semver";
import type { VersionDiff } from "../../versioning/types.js";

export interface DockerTag {
  /** Numeric version portion, e.g. "18.20.0" or "18". */
  version: string;
  /** Variant suffix, e.g. "alpine", "bullseye-slim", or "". */
  suffix: string;
  /** Number of dotted segments in the version (granularity to preserve). */
  segments: number;
}

/** Split a docker tag into its version + variant suffix. */
export function parseDockerTag(tag: string): DockerTag | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:[-.](.+))?$/.exec(tag);
  if (!m) return null;
  const version = m[1]!;
  return { version, suffix: m[2] ?? "", segments: version.split(".").length };
}

/**
 * Pick the newest tag that is an upgrade of `currentTag`: same variant suffix,
 * same version granularity, higher version. Returns null when none qualifies.
 */
export function pickNewerDockerTag(currentTag: string, tags: string[]): string | null {
  const cur = parseDockerTag(currentTag);
  if (!cur) return null;
  const curV = semver.coerce(cur.version);
  if (!curV) return null;

  let best: { tag: string; v: semver.SemVer } | null = null;
  for (const tag of tags) {
    const t = parseDockerTag(tag);
    if (!t || t.suffix !== cur.suffix || t.segments !== cur.segments) continue;
    const v = semver.coerce(t.version);
    if (!v || semver.lte(v, curV)) continue;
    if (!best || semver.gt(v, best.v)) best = { tag, v };
  }
  return best?.tag ?? null;
}

export function dockerUpdateType(fromTag: string, toTag: string): VersionDiff {
  const a = semver.coerce(parseDockerTag(fromTag)?.version ?? "");
  const b = semver.coerce(parseDockerTag(toTag)?.version ?? "");
  if (!a || !b) return "unknown";
  const d = semver.diff(a, b);
  if (d === "major" || d === "premajor") return "major";
  if (d === "minor" || d === "preminor") return "minor";
  if (d == null) return "none";
  return "patch";
}
