import semver from "semver";
import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const DEFAULT_REGISTRY = process.env.SAFEBUMP_NPM_REGISTRY ?? "https://registry.npmjs.org";

interface RegistryVersion {
  deprecated?: string;
  peerDependencies?: Record<string, string>;
}

interface RegistryPackument {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryVersion>;
  time?: Record<string, string>;
}

const packumentCache = new Map<string, Promise<RegistryPackument>>();

async function fetchPackument(
  name: string,
  registry = DEFAULT_REGISTRY,
): Promise<RegistryPackument> {
  const key = `packument:${registry}/${name}`;
  const existing = packumentCache.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace("%40", "@")}`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
    return (await res.json()) as RegistryPackument;
  })();
  packumentCache.set(key, promise);
  return promise;
}

/**
 * Find the highest stable version of `pkg` whose peer requirement on `peerName`
 * is satisfied by `targetVersion`. Drives F1 co-bump: e.g. which
 * @testing-library/react version accepts react@19.
 * Returns null when no published version is compatible.
 */
export async function findPeerCompatibleVersion(
  pkg: string,
  peerName: string,
  targetVersion: string,
  registry = DEFAULT_REGISTRY,
): Promise<string | null> {
  const doc = await fetchPackument(pkg, registry);
  const versions = Object.entries(doc.versions ?? {})
    .filter(([v]) => semver.valid(v) && !semver.prerelease(v))
    .sort((a, b) => semver.rcompare(a[0], b[0]));

  for (const [version, meta] of versions) {
    const peerRange = meta.peerDependencies?.[peerName];
    if (peerRange && semver.satisfies(targetVersion, peerRange)) {
      return version;
    }
  }
  return null;
}

const cache = new Map<string, Promise<PackageMeta>>();

/**
 * Fetch packument metadata from the npm registry.
 * Uses the abbreviated-but-complete document; results are memoised per process.
 */
export function fetchPackageMeta(
  name: string,
  registry = DEFAULT_REGISTRY,
): Promise<PackageMeta> {
  const key = `${registry}/${name}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<PackageMeta> => {
    const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace("%40", "@")}`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`registry ${res.status} for ${name}`);
    }
    const doc = (await res.json()) as RegistryPackument;
    const versionsMap = doc.versions ?? {};
    const time = doc.time ?? {};
    const versions = Object.keys(versionsMap);
    const latest = doc["dist-tags"]?.latest ?? versions.at(-1) ?? "";

    const publishedAt: Record<string, string> = {};
    for (const v of versions) {
      if (time[v]) publishedAt[v] = time[v]!;
    }

    return {
      name: doc.name ?? name,
      latest,
      versions,
      publishedAt,
      deprecated: versionsMap[latest]?.deprecated ?? null,
    };
  })();

  cache.set(key, promise);
  return promise;
}
