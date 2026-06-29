import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse `image: name:tag` entries from a docker-compose file. Skips images
 * pinned by digest, untagged images, and variable references (${...}).
 */
export function parseCompose(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*image:\s*["']?([^"'#\s]+)["']?/.exec(raw);
    if (!m) continue;
    const ref = m[1]!;
    if (ref.includes("@") || ref.includes("${")) continue;
    const colon = ref.lastIndexOf(":");
    if (colon === -1) continue;
    const tag = ref.slice(colon + 1);
    if (tag.includes("/")) continue; // colon was a registry port
    out.push({ name: ref.slice(0, colon), range: tag, kind: "prod" });
  }
  return out;
}

/** Replace an image's tag in a docker-compose `image:` line. */
export function editComposeImageTag(
  content: string,
  image: string,
  fromTag: string,
  toTag: string,
): string {
  const re = new RegExp(
    `^(\\s*image:\\s*["']?${escapeRe(image)}:)${escapeRe(fromTag)}\\b`,
    "m",
  );
  if (!re.test(content)) {
    throw new Error(`could not locate image ${image}:${fromTag} in compose file`);
  }
  return content.replace(re, `$1${toTag}`);
}
