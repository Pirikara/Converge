import type { DependencyEntry } from "../types.js";
import { parsePin } from "../pip/requirements.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace a dependency's exact `==` pin in pyproject.toml (PEP 508 string form). */
export function editPyproject(
  content: string,
  name: string,
  fromPin: string,
  toVersion: string,
): string {
  const re = new RegExp(
    `(["']${escapeRe(name)}(?:\\[[^\\]]*\\])?\\s*==\\s*)${escapeRe(fromPin)}(["'])`,
  );
  if (!re.test(content)) {
    throw new Error(`could not locate ${name}==${fromPin} in pyproject.toml`);
  }
  return content.replace(re, `$1${toVersion}$2`);
}

export interface PyDep extends DependencyEntry {
  pin: string | null;
}

/** Parse a PEP 508 dependency string ("name[extras]>=1.0; marker"). */
function parsePep508(spec: string): PyDep | null {
  const s = spec.split(";")[0]!.trim(); // drop environment marker
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const range = (m[2] ?? "").trim();
  return { name: m[1]!, range, kind: "prod", pin: range ? parsePin(range) : null };
}

/**
 * Parse dependencies from a pyproject.toml — both PEP 621
 * (`[project] dependencies = [...]`) and Poetry
 * (`[tool.poetry.dependencies]` tables). Best-effort, no TOML library.
 */
export function parsePyproject(content: string): PyDep[] {
  const out: PyDep[] = [];

  // PEP 621: dependency arrays under [project] / [project.optional-dependencies]
  const projBlock = /\[project\][\s\S]*?(?=\n\[(?!project)|\n\[project\.[^\]]*\]|$)/.exec(content);
  const optBlocks = content.match(/\[project\.optional-dependencies\][\s\S]*?(?=\n\[(?!project)|$)/g) ?? [];
  for (const block of [projBlock?.[0] ?? "", ...optBlocks]) {
    for (const arr of block.matchAll(/\[([\s\S]*?)\]/g)) {
      for (const str of arr[1]!.matchAll(/["']([^"']+)["']/g)) {
        const d = parsePep508(str[1]!);
        if (d) out.push(d);
      }
    }
  }

  // Poetry: [tool.poetry.dependencies] / group dependencies
  let inPoetry = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPoetry = /^\[tool\.poetry(\.group\.[^\]]+)?\.dependencies\]/.test(line);
      continue;
    }
    if (!inPoetry || line.startsWith("python")) continue;
    const m =
      /^([A-Za-z0-9._-]+)\s*=\s*["']([^"']+)["']/.exec(line) ??
      /^([A-Za-z0-9._-]+)\s*=\s*\{[^}]*?version\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) out.push({ name: m[1]!, range: m[2]!, kind: "prod", pin: parsePin(m[2]!) });
  }

  // de-dupe by name (PEP 621 + poetry shouldn't both appear, but be safe)
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}
