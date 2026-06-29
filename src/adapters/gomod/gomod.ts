import type { DependencyEntry } from "../types.js";

export interface GoRequirement extends DependencyEntry {
  /** Transitive requirement (marked `// indirect`). */
  indirect: boolean;
}

const REQUIRE_LINE = /^\s*([^\s]+)\s+(v[^\s]+)(\s*\/\/\s*indirect)?\s*$/;

/**
 * Parse `require` directives from a go.mod (both block and single-line forms).
 * Versions in go.mod are exact (vX.Y.Z). Replace/exclude directives are ignored.
 */
export function parseGoMod(content: string): GoRequirement[] {
  const out: GoRequirement[] = [];
  const lines = content.split(/\r?\n/);
  let inRequireBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;

    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      pushRequire(out, line);
      continue;
    }
    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (line.startsWith("require ")) {
      pushRequire(out, line.replace(/^require\s+/, ""));
    }
  }
  return out;
}

function pushRequire(out: GoRequirement[], spec: string): void {
  const m = REQUIRE_LINE.exec(spec);
  if (!m) return;
  out.push({
    name: m[1]!,
    range: m[2]!,
    kind: "prod",
    indirect: Boolean(m[3]),
  });
}
