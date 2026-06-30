import { log } from "../../logger.js";

const cache = new Map<string, Promise<string>>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fetch (and cache) a Helm repository's index.yaml text. */
function fetchIndex(repository: string): Promise<string> {
  const repo = repository.replace(/\/+$/, "");
  const existing = cache.get(repo);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    const url = `${repo}/index.yaml`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/x-yaml, text/yaml, */*" } });
    if (!res.ok) throw new Error(`helm index ${res.status} for ${repo}`);
    return res.text();
  })();

  cache.set(repo, promise);
  return promise;
}

/** Extract a chart's published versions from an index.yaml under `entries:`. */
export function extractChartVersions(indexText: string, name: string): string[] {
  const lines = indexText.split("\n");
  let ei = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^entries:\s*$/.test(lines[i]!.replace(/\r$/, ""))) {
      ei = i;
      break;
    }
  }
  if (ei === -1) return [];

  const nameRe = new RegExp(`^(\\s+)${escapeRe(name)}:\\s*$`);
  let chartIndent = -1;
  let start = -1;
  for (let i = ei + 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // left the entries: block
    const m = nameRe.exec(line);
    if (m) {
      chartIndent = m[1]!.length;
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  const versions: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const isListItem = /^\s*-/.test(line);
    // The next chart is a mapping key at the same indent; list items at that
    // indent (YAML allows `key:` and `- item` to share indent) stay in-block.
    if (indent < chartIndent) break;
    if (indent === chartIndent && !isListItem) break;
    const v = /^\s+-?\s*version:\s*["']?([0-9][^"'#\s]*)/.exec(line);
    if (v) versions.push(v[1]!);
  }
  return versions;
}

/** List published versions for `name` in the given Helm repository. */
export async function fetchHelmVersions(repository: string, name: string): Promise<string[]> {
  try {
    return extractChartVersions(await fetchIndex(repository), name);
  } catch (err) {
    log.debug(`helm index failed: ${(err as Error).message}`);
    return [];
  }
}
