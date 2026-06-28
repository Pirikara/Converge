import type { PackageMeta } from "../adapters/types.js";

export type DeprecationKind =
  | "package" // latest version is deprecated → package abandoned/superseded
  | "target-version" // the version we'd upgrade into is deprecated
  | "current-version" // the version currently in use is deprecated
  | "stale"; // no releases for a long time

export interface DeprecationFinding {
  kind: DeprecationKind;
  severity: "warn" | "info";
  detail: string;
  /** Suggested replacement package parsed from the deprecation message. */
  replacement?: string;
}

export interface DeprecationInput {
  name: string;
  currentVersion: string | null;
  targetVersion: string;
}

export interface DeprecationOptions {
  /** Flag "no releases in N days" as stale. */
  staleDays: number;
  now: number;
}

/** Best-effort: pull a replacement package name out of a deprecation message. */
export function parseReplacement(message: string): string | undefined {
  const m =
    /(?:use|migrate to|replaced by|switch to|in favou?r of)\s+[`'"]?(@?[\w][\w@/.-]*)[`'"]?/i.exec(
      message,
    );
  return m?.[1];
}

function ageDays(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Detect deprecation / abandonment from registry metadata only (F4) — no code
 * executed. Covers package-, target-, and current-version deprecation plus
 * staleness.
 */
export function detectDeprecation(
  input: DeprecationInput,
  meta: PackageMeta,
  opts: DeprecationOptions,
): DeprecationFinding[] {
  const findings: DeprecationFinding[] = [];
  const packageDeprecated = meta.deprecated; // deprecation message of `latest`

  if (packageDeprecated) {
    findings.push({
      kind: "package",
      severity: "warn",
      detail: `package is deprecated: ${packageDeprecated}`,
      replacement: parseReplacement(packageDeprecated),
    });
  } else {
    // Only meaningful when the package as a whole isn't already flagged.
    const targetDep = meta.deprecations[input.targetVersion];
    if (targetDep) {
      findings.push({
        kind: "target-version",
        severity: "warn",
        detail: `target version ${input.targetVersion} is deprecated: ${targetDep}`,
        replacement: parseReplacement(targetDep),
      });
    }
  }

  if (input.currentVersion) {
    const currentDep = meta.deprecations[input.currentVersion];
    if (currentDep) {
      findings.push({
        kind: "current-version",
        severity: "warn",
        detail: `current version ${input.currentVersion} is deprecated: ${currentDep}`,
        replacement: parseReplacement(currentDep),
      });
    }
  }

  // Staleness only when not already flagged as deprecated (avoid noise).
  if (!packageDeprecated) {
    const lastPublish = meta.publishedAt[meta.latest];
    if (lastPublish) {
      const age = ageDays(lastPublish, opts.now);
      if (age > opts.staleDays) {
        findings.push({
          kind: "stale",
          severity: "info",
          detail: `no releases in ${(age / 365).toFixed(1)} years (last: ${lastPublish.slice(0, 10)})`,
        });
      }
    }
  }

  return findings;
}
