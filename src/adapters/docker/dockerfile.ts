import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace a base image's tag in a Dockerfile FROM line. */
export function editDockerfileTag(
  content: string,
  image: string,
  fromTag: string,
  toTag: string,
): string {
  const re = new RegExp(
    `^(FROM\\s+(?:--platform=\\S+\\s+)?${escapeRe(image)}:)${escapeRe(fromTag)}\\b`,
    "m",
  );
  if (!re.test(content)) {
    throw new Error(`could not locate FROM ${image}:${fromTag} in Dockerfile`);
  }
  return content.replace(re, `$1${toTag}`);
}

/**
 * Parse `FROM image:tag` lines from a Dockerfile. Skips `scratch`, digest-pinned
 * images, references to earlier build stages, and untagged images. The image is
 * the dependency name; the tag is its "range".
 */
export function parseDockerfile(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const stages = new Set<string>();

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) continue;
    const ref = m[1]!;
    if (m[2]) stages.add(m[2].toLowerCase());

    if (ref.toLowerCase() === "scratch") continue;
    if (ref.includes("@")) continue; // digest-pinned
    if (stages.has(ref.toLowerCase())) continue; // references a prior stage

    // Split image:tag on the last colon, unless that colon is a registry port.
    const colon = ref.lastIndexOf(":");
    if (colon === -1) continue; // untagged (implicit :latest) — skip
    const tag = ref.slice(colon + 1);
    if (tag.includes("/")) continue; // colon was part of a registry host:port
    const image = ref.slice(0, colon);

    out.push({ name: image, range: tag, kind: "prod" });
  }
  return out;
}
