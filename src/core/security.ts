import path from "node:path";
import { GitHubClient, type RepoRef } from "../github/client.js";
import type { Config } from "../config/schema.js";
import type { EcosystemAdapter, EcosystemId, UpdateCandidate } from "../adapters/types.js";
import { getVersioning, type Versioning } from "../versioning/index.js";
import { parseLockfile } from "../audit/lockfiles.js";
import { queryOsv, queryOsvBatch, type OsvVuln } from "../safety/osv.js";
import { NpmAdapter } from "../adapters/npm/index.js";
import { fetchPackageMeta } from "../adapters/npm/registry.js";
import { PipAdapter } from "../adapters/pip/index.js";
import { fetchPyPiMeta } from "../adapters/pip/pypi.js";
import { GoAdapter } from "../adapters/gomod/index.js";
import { fetchGoMeta } from "../adapters/gomod/proxy.js";
import { CargoAdapter } from "../adapters/cargo/index.js";
import { fetchCrateMeta } from "../adapters/cargo/cratesio.js";
import { RubyGemsAdapter } from "../adapters/rubygems/index.js";
import { fetchGemMeta } from "../adapters/rubygems/rubygems.js";
import type { PackageMeta } from "../adapters/types.js";
import { log } from "../logger.js";

/**
 * How to probe one ecosystem for vulnerable *direct* dependencies. v1 covers npm
 * and pip; the shape generalises to the other OSV-indexed ecosystems later.
 */
interface EcoProbe {
  ecosystem: EcosystemId;
  osv: string;
  scheme: string;
  makeAdapter: () => EcosystemAdapter;
  fetchMeta: (name: string) => Promise<PackageMeta>;
  /** Lockfile basenames to consult for the *actually installed* version. */
  lockfiles: string[];
  /** Transform a native version to the form OSV indexes (e.g. Go strips `v`). */
  osvVersion?: (v: string) => string;
  /** Resolve the concrete current version from a manifest range, or null. */
  currentVersion: (range: string, versions: string[], ver: Versioning) => string | null;
}

const PROBES: EcoProbe[] = [
  {
    ecosystem: "npm",
    osv: "npm",
    scheme: "semver",
    makeAdapter: () => new NpmAdapter(),
    fetchMeta: fetchPackageMeta,
    // Prefer the locked version; the manifest range floats to a top that's
    // usually already patched, hiding a lagging lockfile.
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"],
    currentVersion: (range, versions, ver) => ver.maxSatisfying(versions, range),
  },
  {
    ecosystem: "pip",
    osv: "PyPI",
    scheme: "pep440",
    makeAdapter: () => new PipAdapter(),
    // requirements.txt `==` pins already are the installed version — no lockfile.
    lockfiles: [],
    currentVersion: (range) => /^\s*==\s*([^\s,;#]+)\s*$/.exec(range)?.[1] ?? null,
    fetchMeta: fetchPyPiMeta,
  },
  {
    ecosystem: "gomod",
    osv: "Go",
    scheme: "go",
    makeAdapter: () => new GoAdapter(),
    fetchMeta: fetchGoMeta,
    // go.mod pins an exact version per direct module; OSV indexes it without `v`.
    lockfiles: [],
    osvVersion: (v) => v.replace(/^v/, ""),
    currentVersion: (range, _versions, ver) => (ver.isValid(range) ? range : null),
  },
  {
    ecosystem: "cargo",
    osv: "crates.io",
    scheme: "semver",
    makeAdapter: () => new CargoAdapter(),
    fetchMeta: fetchCrateMeta,
    lockfiles: ["Cargo.lock"],
    currentVersion: (range, versions, ver) => ver.maxSatisfying(versions, range),
  },
  {
    ecosystem: "rubygems",
    osv: "RubyGems",
    scheme: "gem",
    makeAdapter: () => new RubyGemsAdapter(),
    fetchMeta: fetchGemMeta,
    lockfiles: ["Gemfile.lock"],
    currentVersion: (range, versions, ver) => ver.maxSatisfying(versions, range),
  },
];

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function topSeverity(vulns: OsvVuln[]): string {
  return vulns.reduce((worst, v) => ((SEVERITY_RANK[v.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0) ? v.severity : worst), "info");
}

/** All ids (incl. aliases) that identify the vulnerabilities affecting a version. */
function idSet(vulns: OsvVuln[]): Set<string> {
  const s = new Set<string>();
  for (const v of vulns) {
    s.add(v.id);
    for (const a of v.aliases) s.add(a);
  }
  return s;
}

/**
 * Find the version that fixes the current vulnerabilities: the earliest
 * ("lowest") or latest ("highest") published stable version above `current`
 * that is not affected by any of `vulnIds`. Scans via OSV (cached).
 */
async function findFixedVersion(
  probe: EcoProbe,
  name: string,
  current: string,
  versions: string[],
  vulnIds: Set<string>,
  ver: Versioning,
  strategy: "lowest" | "highest",
): Promise<string | null> {
  const candidates = versions
    .filter((v) => ver.isValid(v) && ver.isStable(v) && ver.isGreaterThan(v, current))
    .sort((a, b) => ver.compare(a, b));
  if (strategy === "highest") candidates.reverse();

  for (const v of candidates) {
    const vulns = await queryOsv(probe.osv, name, osvForm(probe, v));
    if (!idSet(vulns).size || ![...idSet(vulns)].some((id) => vulnIds.has(id))) {
      return v; // none of the current advisories affect this version
    }
  }
  return null;
}

/** Version string in the form OSV indexes it. */
function osvForm(probe: EcoProbe, v: string): string {
  return probe.osvVersion ? probe.osvVersion(v) : v;
}

/** Map package name → versions present in the manifest dir's lockfile (if any). */
async function lockedVersions(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  dir: string,
  probe: EcoProbe,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const prefix = dir === "." ? "" : `${dir}/`;
  for (const name of probe.lockfiles) {
    const file = await gh.getFile(ref, `${prefix}${name}`, base);
    if (!file) continue;
    const parsed = parseLockfile(name, file.content);
    if (!parsed) continue;
    for (const p of parsed.packages) {
      const arr = map.get(p.name) ?? [];
      arr.push(p.version);
      map.set(p.name, arr);
    }
    break; // first lockfile found wins
  }
  return map;
}

/** Discover manifest paths for a probe's adapter on the base branch. */
async function manifestPaths(gh: GitHubClient, ref: RepoRef, base: string, adapter: EcosystemAdapter): Promise<string[]> {
  if (adapter.manifestMatch) return gh.findManifestPathsMatching(ref, base, adapter.manifestMatch.bind(adapter));
  const lists = await Promise.all(adapter.manifestFilenames.map((f) => gh.findManifestPaths(ref, base, f)));
  return lists.flat();
}

/**
 * Build security-remediation candidates: for each direct dependency whose
 * *current* version is affected by a known vulnerability (OSV), a candidate that
 * bumps it to the fixed version. Direct dependencies only (v1). OSV-indexed
 * ecosystems npm and pip.
 */
export async function securityCandidates(
  gh: GitHubClient,
  ref: RepoRef,
  config: Config,
  base: string,
): Promise<UpdateCandidate[]> {
  if (!config.security.enabled) return [];
  const out: UpdateCandidate[] = [];

  for (const probe of PROBES) {
    if (!(config.ecosystems[probe.ecosystem]?.enabled ?? false)) continue;
    const ver = getVersioning(probe.scheme);
    const adapter = probe.makeAdapter();
    const paths = await manifestPaths(gh, ref, base, adapter);

    for (const mPath of paths) {
      const file = await gh.getFile(ref, mPath, base);
      if (!file) continue;
      let deps;
      try {
        deps = adapter.parseManifestContent(file.content, mPath, "").dependencies;
      } catch {
        continue;
      }
      const dir = path.posix.dirname(mPath) === "." ? "." : path.posix.dirname(mPath);
      const locked = await lockedVersions(gh, ref, base, dir, probe);

      // Resolve each dep's *installed* version (locked when available, else the
      // manifest-range top), then batch-screen against OSV.
      const resolved: { name: string; range: string; kind: UpdateCandidate["kind"]; current: string }[] = [];
      await Promise.all(
        deps.map(async (dep) => {
          try {
            const meta = await probe.fetchMeta(dep.name);
            const inLock = locked.get(dep.name);
            const current =
              (inLock && ver.maxSatisfying(inLock, dep.range)) ??
              probe.currentVersion(dep.range, meta.versions, ver);
            if (current && ver.isValid(current)) resolved.push({ name: dep.name, range: dep.range, kind: dep.kind, current });
          } catch {
            /* unknown package / registry error → skip */
          }
        }),
      );
      if (resolved.length === 0) continue;

      const screen = await queryOsvBatch(probe.osv, resolved.map((r) => ({ name: r.name, version: osvForm(probe, r.current) })));
      for (let i = 0; i < resolved.length; i++) {
        if ((screen[i]?.length ?? 0) === 0) continue; // not vulnerable
        const r = resolved[i]!;
        const vulns = await queryOsv(probe.osv, r.name, osvForm(probe, r.current));
        if (vulns.length === 0) continue;
        const versions = (await probe.fetchMeta(r.name).catch(() => null))?.versions ?? [];
        const fix = await findFixedVersion(probe, r.name, r.current, versions, idSet(vulns), ver, config.security.strategy);
        if (!fix) {
          log.debug(`no fixed version for ${r.name}@${r.current} (${probe.ecosystem})`);
          continue;
        }
        out.push({
          ecosystem: probe.ecosystem,
          manifestPath: mPath,
          dir,
          name: r.name,
          kind: r.kind,
          currentRange: r.range,
          currentVersion: r.current,
          latestVersion: fix,
          updateType: ver.diff(r.current, fix),
          security: { ids: [...idSet(vulns)], severity: topSeverity(vulns) },
        });
      }
    }
  }
  return out;
}
