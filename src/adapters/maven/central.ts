import { log } from "../../logger.js";

const CENTRAL = process.env.CONVERGE_MAVEN_REPO ?? "https://repo1.maven.org/maven2";

const cache = new Map<string, Promise<string[]>>();

/** Split a `group:artifact` coordinate. */
export function splitCoordinate(name: string): { group: string; artifact: string } | null {
  const i = name.indexOf(":");
  if (i === -1) return null;
  const group = name.slice(0, i);
  const artifact = name.slice(i + 1);
  if (!group || !artifact || artifact.includes(":")) return null;
  return { group, artifact };
}

/**
 * List published versions for a `group:artifact` from its maven-metadata.xml on
 * Maven Central. Metadata only; nothing is built. Unknown coordinates resolve to
 * an empty list. Cached per coordinate.
 */
export function fetchMavenVersions(name: string): Promise<string[]> {
  const existing = cache.get(name);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    const c = splitCoordinate(name);
    if (!c) return [];
    const url = `${CENTRAL}/${c.group.replace(/\./g, "/")}/${c.artifact}/maven-metadata.xml`;
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/xml, text/xml, */*" } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`maven central ${res.status} for ${name}`);
    const xml = await res.text();
    const out: string[] = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) out.push(m[1]!.trim());
    return out;
  })();

  cache.set(name, promise);
  return promise;
}
