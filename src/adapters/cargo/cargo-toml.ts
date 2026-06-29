import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace a dependency's version in Cargo.toml (simple or table form). */
export function editCargoToml(
  content: string,
  name: string,
  fromRange: string,
  toVersion: string,
): string {
  const n = escapeRe(name);
  const v = escapeRe(fromRange);
  const simple = new RegExp(`^(\\s*${n}\\s*=\\s*")${v}(")`, "m");
  if (simple.test(content)) return content.replace(simple, `$1${toVersion}$2`);
  const table = new RegExp(`^(\\s*${n}\\s*=\\s*\\{[^}]*?version\\s*=\\s*")${v}(")`, "m");
  if (table.test(content)) return content.replace(table, `$1${toVersion}$2`);
  throw new Error(`could not locate ${name} = "${fromRange}" in Cargo.toml`);
}

/**
 * Parse `[dependencies]` / `[dev-dependencies]` / `[build-dependencies]` (and
 * target-specific ones) from a Cargo.toml. Best-effort, no TOML library.
 * Captures `name = "1.0"` and `name = { version = "1.0", ... }`; skips
 * git/path/workspace dependencies (no published version).
 */
export function parseCargoToml(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  let kind: DependencyEntry["kind"] | null = null;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      if (/dev-dependencies\]\s*$/.test(line)) kind = "dev";
      else if (/build-dependencies\]\s*$/.test(line)) kind = "prod";
      else if (/dependencies\]\s*$/.test(line)) kind = "prod";
      else kind = null;
      continue;
    }
    if (!kind) continue;

    const simple = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (simple) {
      out.push({ name: simple[1]!, range: simple[2]!, kind });
      continue;
    }
    const table = /^([A-Za-z0-9_-]+)\s*=\s*\{.*?\bversion\s*=\s*"([^"]+)"/.exec(line);
    if (table) {
      out.push({ name: table[1]!, range: table[2]!, kind });
    }
    // else: git/path/workspace dep — skipped
  }
  return out;
}
