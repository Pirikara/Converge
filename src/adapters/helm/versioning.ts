import semver from "semver";
import type { UpdateCandidate } from "../types.js";

/**
 * Helm uses Masterminds/semver, which for the common operators (`^ ~ x *`,
 * comparisons, exact) matches npm's `semver`. So constraints are used directly
 * — no translation needed (unlike Composer's tilde).
 */
export function currentSatisfied(constraint: string, versions: string[]): string | null {
  const valid = versions.filter((v) => semver.valid(v));
  try {
    return semver.maxSatisfying(valid, constraint);
  } catch {
    return null; // unparseable constraint (e.g. hyphen range, build alias)
  }
}

export function latestStable(versions: string[]): string | null {
  const stable = versions.filter((v) => semver.valid(v) && !semver.prerelease(v));
  if (stable.length === 0) return null;
  return semver.rsort(stable.slice())[0]!;
}

/**
 * Rewrite a single-term constraint to admit `latest`, preserving operator and
 * granularity (`^1.2` → `^3.0`, `~1.2.3` → `~4.5.6`, `1.2.x` → `4.5.x`, pin
 * `1.2.3` → `4.5.6`). Returns null for multi-term / comparison constraints.
 */
export function bumpConstraint(constraint: string, latest: string): string | null {
  const t = constraint.trim();
  if (/[|,]/.test(t) || /\s/.test(t)) return null; // multi-term
  const lp = latest.split(".");

  let m = /^([\^~])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(t);
  if (m) {
    const op = m[1]!;
    const segs = [m[2], m[3], m[4]].filter((x) => x !== undefined).length;
    if (segs <= 1) return `${op}${lp[0]}`;
    if (segs === 2) return `${op}${lp[0]}.${lp[1]}`;
    return `${op}${lp[0]}.${lp[1]}.${lp[2]}`;
  }
  m = /^v?(\d+)\.(\d+)\.[xX*]$/.exec(t);
  if (m) return `${lp[0]}.${lp[1]}.x`;
  m = /^v?(\d+)\.[xX*]$/.exec(t);
  if (m) return `${lp[0]}.x`;
  m = /^v?\d+\.\d+\.\d+$/.exec(t);
  if (m) return latest;
  return null;
}

export function helmUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  if (!semver.valid(from) || !semver.valid(to)) return "unknown";
  if (semver.eq(from, to)) return "none";
  return (semver.diff(from, to) as UpdateCandidate["updateType"]) ?? "unknown";
}
