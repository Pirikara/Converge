import semver from "semver";
import type { Versioning, VersionDiff } from "./types.js";

/** semver scheme (npm). Optionally tolerates a leading `v` (used by Go tags). */
export function makeSemverVersioning(id: string, stripV = false): Versioning {
  const norm = (v: string): string => {
    const t = v.trim();
    return stripV ? t.replace(/^v/, "") : t;
  };
  return {
    id,
    isValid: (v) => semver.valid(norm(v)) != null,
    isStable: (v) => {
      const n = norm(v);
      return semver.valid(n) != null && semver.prerelease(n) == null;
    },
    compare: (a, b) => semver.compare(norm(a), norm(b)),
    isGreaterThan: (a, b) => semver.gt(norm(a), norm(b)),
    equals: (a, b) => semver.eq(norm(a), norm(b)),
    satisfies: (v, range) => semver.satisfies(norm(v), range, { includePrerelease: false }),
    diff: (from, to): VersionDiff => {
      const a = norm(from);
      const b = norm(to);
      if (!semver.valid(a) || !semver.valid(b)) return "unknown";
      if (semver.eq(a, b)) return "none";
      const d = semver.diff(a, b);
      if (d === "major" || d === "premajor") return "major";
      if (d === "minor" || d === "preminor") return "minor";
      if (d == null) return "none";
      return "patch";
    },
    maxSatisfying: (versions, range) => {
      const stable = versions.map(norm).filter((v) => semver.valid(v) && !semver.prerelease(v));
      return semver.maxSatisfying(stable, range, { includePrerelease: false });
    },
  };
}

export const semverVersioning = makeSemverVersioning("semver");
