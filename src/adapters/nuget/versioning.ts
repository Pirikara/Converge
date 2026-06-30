import type { UpdateCandidate } from "../types.js";

/**
 * NuGet versions are dotted numeric (2–4 parts) with an optional SemVer2
 * prerelease label (`1.2.3-beta.1`) and an ignored build-metadata suffix
 * (`+sha`). This is a focused comparator — enough to pick the newest stable
 * release and classify the delta — not a full SemVer2 implementation.
 */
export interface NuGetVersion {
  parts: number[];
  pre: string[]; // empty = stable release
}

export function parseNuGetVersion(input: string): NuGetVersion | null {
  const v = input.trim().replace(/\+.*$/, ""); // drop build metadata
  const [core, ...preRest] = v.split("-");
  const preLabel = preRest.join("-");
  const segs = core!.split(".");
  if (segs.length < 2 || segs.length > 4 || !segs.every((s) => /^\d+$/.test(s))) return null;
  return { parts: segs.map(Number), pre: preLabel ? preLabel.split(".") : [] };
}

function cmpParts(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function cmpPre(a: string[], b: string[]): number {
  // A stable release (no prerelease) outranks a prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // shorter prerelease precedes
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else {
      const d = ai.localeCompare(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function compareNuGet(a: string, b: string): number {
  const pa = parseNuGetVersion(a);
  const pb = parseNuGetVersion(b);
  if (!pa || !pb) return 0;
  return cmpParts(pa.parts, pb.parts) || cmpPre(pa.pre, pb.pre);
}

export function isStable(v: string): boolean {
  const p = parseNuGetVersion(v);
  return p != null && p.pre.length === 0;
}

/** Highest stable version, or null. */
export function maxStableNuGet(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!isStable(v)) continue;
    if (best === null || compareNuGet(v, best) > 0) best = v;
  }
  return best;
}

export function nugetUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  const a = parseNuGetVersion(from);
  const b = parseNuGetVersion(to);
  if (!a || !b) return "unknown";
  if ((a.parts[0] ?? 0) !== (b.parts[0] ?? 0)) return "major";
  if ((a.parts[1] ?? 0) !== (b.parts[1] ?? 0)) return "minor";
  if ((a.parts[2] ?? 0) !== (b.parts[2] ?? 0)) return "patch";
  if ((a.parts[3] ?? 0) !== (b.parts[3] ?? 0)) return "patch";
  return "none";
}
