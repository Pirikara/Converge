import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const API = process.env.CONVERGE_CRATES_API ?? "https://crates.io";

interface CrateVersion {
  num: string;
  created_at?: string;
  yanked?: boolean;
}

const cache = new Map<string, Promise<PackageMeta>>();

/** Fetch crates.io metadata (latest stable + all versions) into the shared shape. */
export function fetchCrateMeta(name: string): Promise<PackageMeta> {
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<PackageMeta> => {
    const url = `${API}/api/v1/crates/${encodeURIComponent(name)}`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "converge" } });
    if (!res.ok) throw new Error(`crates.io ${res.status} for ${name}`);
    const doc = (await res.json()) as {
      crate: { max_stable_version?: string; newest_version?: string; repository?: string | null };
      versions?: CrateVersion[];
    };

    const versions: string[] = [];
    const publishedAt: Record<string, string> = {};
    const deprecations: Record<string, string> = {};
    for (const v of doc.versions ?? []) {
      versions.push(v.num);
      if (v.created_at) publishedAt[v.num] = v.created_at;
      if (v.yanked) deprecations[v.num] = "yanked";
    }

    return {
      name,
      latest: doc.crate.max_stable_version ?? doc.crate.newest_version ?? versions[0] ?? "",
      versions,
      publishedAt,
      deprecated: null,
      deprecations,
      provenance: {},
      repositoryUrl: doc.crate.repository ?? null,
    };
  })();

  cache.set(name, promise);
  return promise;
}
