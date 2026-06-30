import { log } from "../../logger.js";

const FLAT = process.env.CONVERGE_NUGET_API ?? "https://api.nuget.org/v3-flatcontainer";

const cache = new Map<string, Promise<string[]>>();

/**
 * List published versions for a NuGet package id via the v3 flat-container index
 * (`/{id}/index.json`, ids are lower-cased). Metadata only; nothing is restored
 * or built. Unknown ids resolve to an empty list. Cached per id.
 */
export function fetchNuGetVersions(id: string): Promise<string[]> {
  const key = id.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    const url = `${FLAT}/${encodeURIComponent(key)}/index.json`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`nuget ${res.status} for ${id}`);
    const data = (await res.json()) as { versions?: string[] };
    return data.versions ?? [];
  })();

  cache.set(key, promise);
  return promise;
}
