import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const API = process.env.CONVERGE_RUBYGEMS_API ?? "https://rubygems.org";

interface GemVersion {
  number: string;
  created_at?: string;
  prerelease?: boolean;
}

const cache = new Map<string, Promise<PackageMeta>>();

/** Fetch RubyGems metadata (latest + versions) into the shared shape. */
export function fetchGemMeta(name: string): Promise<PackageMeta> {
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<PackageMeta> => {
    log.debug(`GET ${API}/api/v1/gems/${name}.json`);
    const gemRes = await fetch(`${API}/api/v1/gems/${encodeURIComponent(name)}.json`, {
      headers: { accept: "application/json" },
    });
    if (!gemRes.ok) throw new Error(`rubygems ${gemRes.status} for ${name}`);
    const gem = (await gemRes.json()) as {
      version: string;
      source_code_uri?: string | null;
      homepage_uri?: string | null;
    };

    const versions: string[] = [];
    const publishedAt: Record<string, string> = {};
    try {
      const vRes = await fetch(`${API}/api/v1/versions/${encodeURIComponent(name)}.json`);
      if (vRes.ok) {
        for (const v of (await vRes.json()) as GemVersion[]) {
          versions.push(v.number);
          if (v.created_at) publishedAt[v.number] = v.created_at;
        }
      }
    } catch {
      /* versions endpoint optional */
    }
    if (versions.length === 0) versions.push(gem.version);

    return {
      name,
      latest: gem.version,
      versions,
      publishedAt,
      deprecated: null,
      deprecations: {},
      provenance: {},
      repositoryUrl: gem.source_code_uri ?? gem.homepage_uri ?? null,
    };
  })();

  cache.set(name, promise);
  return promise;
}
