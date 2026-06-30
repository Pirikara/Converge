import semver from "semver";
import type { UpdateCandidate } from "../types.js";

/** Translate one Composer constraint term to an npm range fragment, or null. */
function translateTerm(t: string): string | null {
  const term = t.trim();
  if (!term) return null;
  if (term === "*") return "*";

  // Wildcards: 1.2.* / 1.*
  let m = /^v?(\d+)\.(\d+)\.\*$/.exec(term);
  if (m) return `${m[1]}.${m[2]}.x`;
  m = /^v?(\d+)\.\*$/.exec(term);
  if (m) return `${m[1]}.x`;

  // Caret / tilde. Composer `~X.Y` allows up to <(X+1) (≈ npm `^X.Y`);
  // `~X.Y.Z` allows up to <X.(Y+1) (= npm `~X.Y.Z`). `^` matches npm `^`.
  m = /^([\^~])\s*v?(\d+(?:\.\d+){0,2})$/.exec(term);
  if (m) {
    const op = m[1]!;
    const ver = m[2]!;
    if (op === "^") return `^${ver}`;
    return ver.split(".").length <= 2 ? `^${ver}` : `~${ver}`;
  }

  // Comparison operators.
  m = /^(>=|<=|>|<|=|!=)\s*v?(\d+(?:\.\d+){0,2})$/.exec(term);
  if (m) {
    if (m[1] === "!=") return null;
    return m[1] === "=" ? `=${m[2]}` : `${m[1]}${m[2]}`;
  }

  // Bare exact version.
  m = /^v?(\d+(?:\.\d+){0,2})$/.exec(term);
  if (m) return `=${m[1]}`;
  return null;
}

/**
 * Translate a Composer version constraint to an npm-style range for `semver`.
 * Handles `||` (OR), comma/space AND, `^ ~ *`, comparisons, and exacts. Returns
 * null for forms we can't model (hyphen ranges, `!=`, stability flags).
 */
export function composerConstraintToRange(constraint: string): string | null {
  const orTerms = constraint.split("||");
  const ranges: string[] = [];
  for (const ot of orTerms) {
    const andTerms = ot.trim().split(/\s*,\s*|\s+/).filter(Boolean);
    if (andTerms.length === 0) return null;
    const parts: string[] = [];
    for (const term of andTerms) {
      const tr = translateTerm(term);
      if (!tr) return null;
      parts.push(tr);
    }
    ranges.push(parts.join(" "));
  }
  return ranges.join(" || ");
}

/** Highest concrete version satisfying `constraint`, or null. */
export function currentSatisfied(constraint: string, versions: string[]): string | null {
  const range = composerConstraintToRange(constraint);
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
 * Rewrite a single-term constraint to admit `latest`, preserving operator and
 * granularity (`^1.2` → `^2.0`, `~1.2.3` → `~4.5.6`, `1.2.*` → `4.5.*`, pin
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
  m = /^v?(\d+)\.(\d+)\.\*$/.exec(t);
  if (m) return `${lp[0]}.${lp[1]}.*`;
  m = /^v?(\d+)\.\*$/.exec(t);
  if (m) return `${lp[0]}.*`;
  m = /^v?\d+\.\d+\.\d+$/.exec(t);
  if (m) return latest;
  return null;
}

/** semver delta between two concrete versions, for the update-type filter. */
export function composerUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  if (!semver.valid(from) || !semver.valid(to)) return "unknown";
  if (semver.eq(from, to)) return "none";
  return (semver.diff(from, to) as UpdateCandidate["updateType"]) ?? "unknown";
}
