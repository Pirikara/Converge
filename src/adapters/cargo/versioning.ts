import semver from "semver";
import type { UpdateCandidate } from "../types.js";

/**
 * Cargo's SemVer compatibility rule: for `0.x` versions the left-most non-zero
 * component is the breaking boundary. So `0.24.7 → 0.26.10` is a *breaking*
 * change (not a minor one), and `0.0.5 → 0.0.6` is breaking too — while
 * `0.24.7 → 0.24.10` is a patch. Standard SemVer `diff` would call `0.24 → 0.26`
 * "minor", which makes the update-type filter propose a breaking bump under
 * `minor,patch`. Classify the Cargo way instead.
 */
export function cargoUpdateType(from: string, to: string): UpdateCandidate["updateType"] {
  const a = semver.coerce(from);
  const b = semver.coerce(to);
  if (!a || !b) return "unknown";
  if (a.major !== b.major) return "major";
  if (a.major === 0) {
    if (a.minor !== b.minor) return "major"; // 0.24 → 0.26 (breaking)
    if (a.minor === 0) return a.patch !== b.patch ? "major" : "none"; // 0.0.z (breaking)
    return a.patch !== b.patch ? "patch" : "none"; // 0.24.7 → 0.24.10 (compatible)
  }
  if (a.minor !== b.minor) return "minor";
  return a.patch !== b.patch ? "patch" : "none";
}
