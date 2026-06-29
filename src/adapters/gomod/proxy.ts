import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const GOPROXY = process.env.CONVERGE_GOPROXY ?? "https://proxy.golang.org";

/** Go module proxy escaping: uppercase letters become `!` + lowercase. */
export function escapeModulePath(p: string): string {
  return p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

const cache = new Map<string, Promise<PackageMeta>>();

/** Fetch Go module metadata from the module proxy into the shared shape. */
export function fetchGoMeta(modulePath: string): Promise<PackageMeta> {
  const existing = cache.get(modulePath);
  if (existing) return existing;

  const promise = (async (): Promise<PackageMeta> => {
    const esc = escapeModulePath(modulePath);
    const base = `${GOPROXY}/${esc}`;
    log.debug(`GET ${base}/@latest`);

    const latestRes = await fetch(`${base}/@latest`, { headers: { accept: "application/json" } });
    if (!latestRes.ok) throw new Error(`goproxy ${latestRes.status} for ${modulePath}`);
    const latest = (await latestRes.json()) as { Version: string; Time?: string };

    let versions = [latest.Version];
    try {
      const listRes = await fetch(`${base}/@v/list`);
      if (listRes.ok) {
        const list = (await listRes.text()).split("\n").map((l) => l.trim()).filter(Boolean);
        if (list.length > 0) versions = list;
      }
    } catch {
      /* @v/list optional */
    }

    return {
      name: modulePath,
      latest: latest.Version,
      versions,
      publishedAt: latest.Time ? { [latest.Version]: latest.Time } : {},
      deprecated: null,
      deprecations: {},
      provenance: {},
      repositoryUrl: `https://${modulePath}`,
    };
  })();

  cache.set(modulePath, promise);
  return promise;
}
