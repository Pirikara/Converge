import { log } from "../../logger.js";

const HUB = process.env.CONVERGE_DOCKERHUB_API ?? "https://hub.docker.com";

/** Map a Docker image ref to a Docker Hub repository path, or null if not on Hub. */
export function hubRepo(image: string): string | null {
  // Registry-qualified refs (ghcr.io/…, gcr.io/…, host:port/…) aren't Docker Hub.
  const firstSeg = image.split("/")[0]!;
  if (firstSeg.includes(".") || firstSeg.includes(":")) return null;
  if (!image.includes("/")) return `library/${image}`; // official image
  return image;
}

const cache = new Map<string, Promise<string[]>>();

/** List tags for a Docker Hub image (first page, 100 tags). */
export function fetchDockerTags(image: string): Promise<string[]> {
  const repo = hubRepo(image);
  if (!repo) return Promise.resolve([]);
  const existing = cache.get(repo);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    const url = `${HUB}/v2/repositories/${repo}/tags?page_size=100`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`dockerhub ${res.status} for ${repo}`);
    const data = (await res.json()) as { results?: { name: string }[] };
    return (data.results ?? []).map((t) => t.name);
  })();

  cache.set(repo, promise);
  return promise;
}
