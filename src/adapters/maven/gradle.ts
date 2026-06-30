import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A quoted `group:artifact:version` coordinate (Groovy or Kotlin DSL).
const COORD = /['"]([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)['"]/g;

/** Parse `"group:artifact:version"` dependency coordinates from a build.gradle(.kts). */
export function parseGradle(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  COORD.lastIndex = 0;
  while ((m = COORD.exec(content))) {
    const version = m[3]!;
    // Skip dynamic/interpolated versions; require a numeric release.
    if (!/^\d/.test(version) || version.includes("+")) continue;
    const name = `${m[1]}:${m[2]}`;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, range: version, kind: "prod" });
  }
  return out;
}

/** Replace `group:artifact:from` with `…:to` in a build.gradle(.kts). */
export function editGradleVersion(content: string, name: string, from: string, to: string): string {
  const re = new RegExp(`(['"]${escapeRe(name)}:)${escapeRe(from)}(['"])`);
  if (!re.test(content)) {
    throw new Error(`could not locate ${name}:${from} in build.gradle`);
  }
  return content.replace(re, `$1${to}$2`);
}
