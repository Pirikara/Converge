export type VersionDiff = "major" | "minor" | "patch" | "none" | "unknown";

/**
 * A versioning scheme (SPEC scaling axis, inspired by the manager×datasource×
 * versioning separation). Each ecosystem references one by id.
 */
export interface Versioning {
  id: string;
  isValid(v: string): boolean;
  /** A release version (no pre-release / dev marker). */
  isStable(v: string): boolean;
  /** -1 if a<b, 0 if equal, 1 if a>b. */
  compare(a: string, b: string): number;
  isGreaterThan(a: string, b: string): boolean;
  equals(a: string, b: string): boolean;
  satisfies(version: string, range: string): boolean;
  /** semver-style bump classification of from→to. */
  diff(from: string, to: string): VersionDiff;
  /** Highest version in `versions` satisfying `range` (stable only). */
  maxSatisfying(versions: string[], range: string): string | null;
}
