import type { PackageMeta } from "../types.js";
import { log } from "../../logger.js";

const PYPI_API = process.env.CONVERGE_PYPI_API ?? "https://pypi.org";

interface PyPiFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
  yanked_reason?: string | null;
}

interface PyPiDoc {
  info: {
    version: string;
    project_urls?: Record<string, string> | null;
    home_page?: string | null;
  };
  releases: Record<string, PyPiFile[]>;
}

const cache = new Map<string, Promise<PackageMeta>>();

function pickRepoUrl(urls: Record<string, string> | null | undefined): string | null {
  if (!urls) return null;
  for (const key of ["Source", "Repository", "Source Code", "Homepage", "Home"]) {
    if (urls[key]) return urls[key]!;
  }
  return Object.values(urls)[0] ?? null;
}

/** Fetch PyPI project metadata and map it to the shared PackageMeta shape. */
export function fetchPyPiMeta(name: string): Promise<PackageMeta> {
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<PackageMeta> => {
    const url = `${PYPI_API}/pypi/${encodeURIComponent(name)}/json`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`PyPI ${res.status} for ${name}`);
    const doc = (await res.json()) as PyPiDoc;

    const versions = Object.keys(doc.releases);
    const publishedAt: Record<string, string> = {};
    const deprecations: Record<string, string> = {};
    for (const [v, files] of Object.entries(doc.releases)) {
      const first = files[0];
      if (first?.upload_time_iso_8601) publishedAt[v] = first.upload_time_iso_8601;
      // A release is yanked when every file is yanked (PEP 592). We surface this
      // through the deprecation channel so F4 flags yanked target/current versions.
      if (files.length > 0 && files.every((f) => f.yanked)) {
        const reason = files.find((f) => f.yanked_reason)?.yanked_reason;
        deprecations[v] = `yanked${reason ? `: ${reason}` : ""}`;
      }
    }

    return {
      name,
      latest: doc.info.version,
      versions,
      publishedAt,
      deprecated: null,
      deprecations,
      provenance: {}, // PEP 740 attestations deferred for pip
      repositoryUrl: pickRepoUrl(doc.info.project_urls) ?? doc.info.home_page ?? null,
    };
  })();

  cache.set(name, promise);
  return promise;
}
