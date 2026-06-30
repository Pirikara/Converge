import semver from "semver";
import type { UpdateCandidate } from "../types.js";

/**
 * Translate a Terraform version constraint to an npm-style range so we can reuse
 * `semver`. Supports `= != > >= < <= ~>` and comma-separated AND. The pessimistic
 * `~>` maps to caret/tilde: `~> a.b` → `^a.b.0` (a.x), `~> a.b.c` → `~a.b.c`
 * (a.b.x). Returns null for constraints we can't model (e.g. `!=`, prereleases).
 */
export function tfConstraintToRange(constraint: string): string | null {
  const terms = constraint.split(",").map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return null;
  const parts: string[] = [];
  for (const t of terms) {
    const m = /^(=|!=|>=|<=|>|<|~>)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(t);
    if (!m) return null; // unrecognised / has prerelease or build suffix
    const op = m[1] ?? "=";
    const ver = m[2]!;
    if (op === "!=") return null; // not simply representable
    if (op === "~>") {
      const segs = ver.split(".").length;
      if (segs >= 3) parts.push(`~${ver}`);
      else if (segs === 2) parts.push(`^${ver}.0`);
      else parts.push(`>=${ver}`);
    } else if (op === "=") {
      parts.push(`=${ver}`);
    } else {
      parts.push(`${op}${ver}`);
    }
  }
  return parts.join(" ");
}

/** Highest concrete version satisfying `constraint`, or null. */
export function currentSatisfied(constraint: string, versions: string[]): string | null {
  const range = tfConstraintToRange(constraint);
  if (!range) return null;
  const valid = versions.filter((v) => semver.valid(v));
  return semver.maxSatisfying(valid, range);
}

/** Highest stable published version. */
export function latestStable(versions: string[]): string | null {
  const stable = versions.filter((v) => semver.valid(v) && !semver.prerelease(v));
  if (stable.length === 0) return null;
  return semver.rsort(stable.slice())[0]!;
}

/**
 * Rewrite a constraint to admit `latest`, preserving its operator/granularity:
 *  - pin (`1.2.3` / `= 1.2.3`) → the new version, keeping the `=` style
 *  - `~> a.b` → `~> {newMajor}.0`; `~> a.b.c` → `~> {newMajor}.{newMinor}.0`
 * Returns null for forms we won't rewrite (open `>=` ranges, etc).
 */
export function bumpConstraint(constraint: string, latest: string): string | null {
  const t = constraint.trim();
  const lp = latest.split(".");

  let m = /^(=\s*)?v?\d+\.\d+\.\d+$/.exec(t);
  if (m) return m[1] ? `= ${latest}` : latest;

  m = /^~>\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(t);
  if (m) {
    const segs = [m[1], m[2], m[3]].filter((x) => x !== undefined).length;
    if (segs === 2) return `~> ${lp[0]}.0`;
    if (segs >= 3) return `~> ${lp[0]}.${lp[1]}.0`;
    return `~> ${lp[0]}`;
  }
  return null;
}

/** semver delta between two concrete versions, for the update-type filter. */
export function tfUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  if (!semver.valid(from) || !semver.valid(to)) return "unknown";
  if (semver.eq(from, to)) return "none";
  return (semver.diff(from, to) as UpdateCandidate["updateType"]) ?? "unknown";
}
