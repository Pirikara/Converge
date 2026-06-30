import type { UpdateCandidate } from "../types.js";

// Pre-release qualifiers (Maven orders these below a final release).
const PRERELEASE = /(?:^|[.\-_])(?:alpha|beta|milestone|m\d|rc|cr|snapshot|pre|preview|dev|ea|b\d|a\d)(?:[.\-_]|\d|$)/i;
// Qualifiers that still denote a stable release.
const RELEASE_QUALIFIER = /^(?:release|final|ga|sp\d*)$/i;

/** A Maven version is "stable" when it carries no pre-release qualifier. */
export function isStable(version: string): boolean {
  const v = version.trim();
  if (v.endsWith("-SNAPSHOT") || v.toUpperCase().includes("SNAPSHOT")) return false;
  return !PRERELEASE.test(v);
}

/** Leading numeric release tuple (`2.15.0.RELEASE` → [2,15,0]). */
function releaseTuple(version: string): number[] {
  const tuple: number[] = [];
  for (const tok of version.split(/[.\-_]/)) {
    if (/^\d+$/.test(tok)) tuple.push(Number(tok));
    else if (RELEASE_QUALIFIER.test(tok)) continue; // .RELEASE/.FINAL/.GA → ignore
    else break; // first non-numeric, non-release token ends the tuple
  }
  return tuple;
}

function cmpTuple(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Compare two stable Maven versions by their numeric release tuples. */
export function compareMaven(a: string, b: string): number {
  return cmpTuple(releaseTuple(a), releaseTuple(b));
}

/**
 * The non-numeric "flavor" suffix of a version (e.g. Guava's `jre`/`android`),
 * excluding release qualifiers. Used to keep an update on the same release line.
 */
export function flavor(version: string): string {
  const tokens = version.split(/[.\-_]/);
  let i = 0;
  while (i < tokens.length && /^\d+$/.test(tokens[i]!)) i++; // skip numeric prefix
  return tokens
    .slice(i)
    .filter((t) => !RELEASE_QUALIFIER.test(t))
    .join("-")
    .toLowerCase();
}

/** Highest stable version, or null. */
export function maxStableMaven(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!isStable(v)) continue;
    if (releaseTuple(v).length === 0) continue;
    if (best === null || compareMaven(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Highest stable version on the *same release line* as `current` (matching
 * flavor — e.g. won't move a Guava `-jre` user to `-android`). Falls back to the
 * overall highest stable when no same-flavor version exists.
 */
export function maxStableMavenFor(current: string, versions: string[]): string | null {
  const want = flavor(current);
  const sameLine = versions.filter((v) => isStable(v) && releaseTuple(v).length > 0 && flavor(v) === want);
  if (sameLine.length === 0) return maxStableMaven(versions);
  let best = sameLine[0]!;
  for (const v of sameLine) if (compareMaven(v, best) > 0) best = v;
  return best;
}

export function mavenUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  const a = releaseTuple(from);
  const b = releaseTuple(to);
  if (a.length === 0 || b.length === 0) return "unknown";
  if (cmpTuple(a, b) === 0) return "none";
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return "major";
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return "minor";
  return "patch";
}
