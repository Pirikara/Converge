import { getVersioning, type Versioning } from "../versioning/index.js";
import { cargoUpdateType } from "../adapters/cargo/versioning.js";
import type { EcosystemId, PackageMeta, UpdateCandidate } from "../adapters/types.js";
import type { Config } from "../config/schema.js";

// Ecosystems whose registry gives per-version publish dates and a comparable
// versioning scheme. Others (NuGet/Maven/refs) keep the plain gate behaviour.
const SCHEME: Partial<Record<EcosystemId, string>> = {
  npm: "semver",
  cargo: "semver",
  composer: "semver",
  pip: "pep440",
  gomod: "go",
  rubygems: "gem",
};

function versioningFor(ecosystem: EcosystemId): Versioning | null {
  const scheme = SCHEME[ecosystem];
  return scheme ? getVersioning(scheme) : null;
}

function ageDays(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 86_400_000;
}

/**
 * Cooldown by *maturity selection*: when the chosen target version is younger
 * than `cooldownDays`, step down to the newest version that IS old enough —
 * still an upgrade over current, never above the originally-chosen target. This
 * is how npm/pnpm/yarn, Dependabot, and Renovate apply cooldown: don't skip the
 * update, just pick a matured version. Returns the adjusted target, or null to
 * leave the candidate as-is (the F2 gate then holds it if still too fresh, e.g.
 * no matured version exists, or the ecosystem has no publish-date scheme).
 */
export function maturedTarget(
  candidate: UpdateCandidate,
  meta: PackageMeta,
  policy: Config["safety"],
  now: number,
): { latestVersion: string; updateType: UpdateCandidate["updateType"] } | null {
  if (policy.cooldownDays <= 0) return null;
  // Security fixes bypass cooldown (policy #1): keep the exact remediation
  // version — never step it down (that could drop below the fixed version).
  if (candidate.security) return null;
  const ver = versioningFor(candidate.ecosystem);
  if (!ver) return null;

  const target = candidate.latestVersion;
  const targetDate = meta.publishedAt[target];
  // Target already matured (or age unknown) → nothing to do.
  if (!targetDate || ageDays(targetDate, now) >= policy.cooldownDays) return null;

  const current = candidate.currentVersion;
  let best: string | null = null;
  for (const v of meta.versions) {
    if (!ver.isValid(v) || !ver.isStable(v)) continue;
    if (ver.compare(v, target) > 0) continue; // never exceed the chosen target
    if (current && ver.compare(v, current) <= 0) continue; // must be an upgrade
    const d = meta.publishedAt[v];
    if (!d || ageDays(d, now) < policy.cooldownDays) continue; // must be matured
    if (best === null || ver.compare(v, best) > 0) best = v;
  }
  if (best === null || best === target) return null;

  const updateType =
    candidate.ecosystem === "cargo"
      ? cargoUpdateType(current ?? best, best)
      : ver.diff(current ?? best, best);
  return { latestVersion: best, updateType };
}
