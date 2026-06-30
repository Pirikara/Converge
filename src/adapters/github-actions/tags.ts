import { log } from "../../logger.js";
import { resolveToken } from "../../github/client.js";

const API = process.env.CONVERGE_GITHUB_API ?? "https://api.github.com";

const cache = new Map<string, Promise<string[]>>();

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
 * List git tags for a `owner/repo` action via the GitHub REST API (first page,
 * 100 tags — actions rarely keep more relevant version tags than that). Metadata
 * only; no action code is fetched or run. Unknown repos resolve to an empty list.
 */
export function fetchActionTags(name: string): Promise<string[]> {
  const [owner, repo] = name.split("/");
  if (!owner || !repo) return Promise.resolve([]);
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    const url = `${API}/repos/${owner}/${repo}/tags?per_page=100`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`github tags ${res.status} for ${name}`);
    const data = (await res.json()) as { name?: string }[];
    return data.map((t) => t.name).filter((n): n is string => typeof n === "string");
  })();

  cache.set(name, promise);
  return promise;
}
