import { log } from "../../logger.js";

const REPO = process.env.CONVERGE_PACKAGIST_API ?? "https://repo.packagist.org";

const cache = new Map<string, Promise<string[]>>();

/**
 * List published versions for a `vendor/package` from the Packagist metadata
 * (v2) endpoint. Metadata only; no Composer is run. Leading `v` is stripped and
 * `dev-*` / branch aliases are dropped (callers filter to valid semver anyway).
 * Unknown packages resolve to an empty list. Cached per package.
 */
export function fetchComposerVersions(name: string): Promise<string[]> {
  const key = name.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    const url = `${REPO}/p2/${key}.json`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`packagist ${res.status} for ${name}`);
    const data = (await res.json()) as { packages?: Record<string, { version?: string }[]> };
    const releases = data.packages?.[key] ?? data.packages?.[name] ?? [];
    return releases
      .map((r) => r.version)
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.replace(/^v/, ""));
  })();

  cache.set(key, promise);
  return promise;
}
