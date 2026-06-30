import { log } from "../../logger.js";
import { resolveToken } from "../../github/client.js";

const API = process.env.CONVERGE_GITHUB_API ?? "https://api.github.com";

export interface ActionTag {
  name: string;
  /** Commit SHA the tag points at (used for SHA-pinned `uses:` refs). */
  sha: string;
}

const cache = new Map<string, Promise<ActionTag[]>>();

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "converge",
    "x-github-api-version": "2022-11-28",
  };
  try {
    const token = resolveToken();
    if (token) headers.authorization = `Bearer ${token}`;
  } catch {
    /* unauthenticated: subject to the 60 req/hr limit */
  }
  return headers;
}

/**
 * List git tags (name + commit SHA) for a `owner/repo` action via the GitHub
 * REST API (first page, 100 tags — actions rarely keep more relevant version
 * tags than that). Metadata only; no action code is fetched or run. Unknown
 * repos resolve to an empty list. Cached per repo for the process.
 */
export function fetchActionTagRefs(name: string): Promise<ActionTag[]> {
  const [owner, repo] = name.split("/");
  if (!owner || !repo) return Promise.resolve([]);
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<ActionTag[]> => {
    const url = `${API}/repos/${owner}/${repo}/tags?per_page=100`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`github tags ${res.status} for ${name}`);
    const data = (await res.json()) as { name?: string; commit?: { sha?: string } }[];
    return data
      .filter((t): t is { name: string; commit: { sha: string } } =>
        typeof t.name === "string" && typeof t.commit?.sha === "string",
      )
      .map((t) => ({ name: t.name, sha: t.commit.sha }));
  })();

  cache.set(name, promise);
  return promise;
}

/** Tag names only (for version comparison). */
export async function fetchActionTags(name: string): Promise<string[]> {
  return (await fetchActionTagRefs(name)).map((t) => t.name);
}
