import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const DEFAULT_REGISTRY = process.env.SAFEBUMP_NPM_REGISTRY ?? "https://registry.npmjs.org";

interface RegistryPackument {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { deprecated?: string }>;
  time?: Record<string, string>;
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
