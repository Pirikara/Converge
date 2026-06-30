import semver from "semver";
import type { UpdateCandidate } from "../types.js";

interface ParsedRef {
  major: number;
  minor: number;
  patch: number;
  /** Dotted-segment count of the original ref: 1 = `v4` (floating major). */
  granularity: number;
  /** Original tag string as written (e.g. "v4.1.1"). */
  original: string;
}

function hasVPrefix(ref: string): boolean {
  return /^v/i.test(ref);
}

/** Parse an action tag (`v4`, `v4.1`, `v4.1.1`, `4.2.0`) into semver parts. */
export function parseActionRef(ref: string): ParsedRef | null {
  const bare = ref.replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,2}$/.test(bare)) return null; // not a plain version tag
  const parts = bare.split(".").map((n) => Number(n));
  return {
    major: parts[0]!,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    granularity: parts.length,
    original: ref,
  };
}

function toSemver(p: ParsedRef): string {
  return `${p.major}.${p.minor}.${p.patch}`;
}

/**
 * Pick a newer tag for `currentRef` from the available `tags`. Two conventions:
 *  - floating major (`v4`): only bumps when a newer *major* tag exists → `v5`,
 *    since `v4` already tracks v4.x. Preserves the `v` prefix.
 *  - pinned (`v4.1.1` / `4.1.1`): bumps to the newest concrete tag.
 * Pre-release tags are ignored. Returns the target tag string, or null.
 */
export function pickNewerActionTag(currentRef: string, tags: string[]): string | null {
  const cur = parseActionRef(currentRef);
  if (!cur) return null;

  const parsed = tags
    .map(parseActionRef)
    .filter((p): p is ParsedRef => p != null);
  if (parsed.length === 0) return null;

  if (cur.granularity === 1) {
    let newestMajor = cur.major;
    for (const p of parsed) if (p.major > newestMajor) newestMajor = p.major;
    if (newestMajor <= cur.major) return null;
    return `${hasVPrefix(currentRef) ? "v" : ""}${newestMajor}`;
  }

  let best: ParsedRef | null = null;
  for (const p of parsed) {
    if (!semver.gt(toSemver(p), toSemver(cur))) continue;
    if (!best) {
      best = p;
    } else if (semver.gt(toSemver(p), toSemver(best))) {
      best = p;
    } else if (semver.eq(toSemver(p), toSemver(best)) && p.granularity > best.granularity) {
      // Same version, but a more specific tag (v5.0.0 over v5) for a pinned ref.
      best = p;
    }
  }
  return best ? best.original : null;
}

/** semver delta between two action tags, for the update-type filter. */
export function actionUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  const a = parseActionRef(from);
  const b = parseActionRef(to);
  if (!a || !b) return "unknown";
  if (b.major !== a.major) return "major";
  if (b.minor !== a.minor) return "minor";
  if (b.patch !== a.patch) return "patch";
  return "none";
}
