import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Platform requirements that aren't Packagist packages. */
function isPlatform(name: string): boolean {
  return name === "php" || name.startsWith("ext-") || name.startsWith("lib-") || !name.includes("/");
}

/** Parse `require` + `require-dev` from a composer.json (skips platform reqs). */
export function parseComposerJson(content: string): DependencyEntry[] {
  let data: { require?: Record<string, string>; "require-dev"?: Record<string, string> };
  try {
    data = JSON.parse(content) as typeof data;
  } catch {
    return [];
  }
  const out: DependencyEntry[] = [];
  for (const [block, kind] of [["require", "prod"], ["require-dev", "dev"]] as const) {
    const deps = data[block];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (isPlatform(name) || typeof range !== "string") continue;
      out.push({ name, range, kind });
    }
  }
  return out;
}

/** Replace `"vendor/pkg": "<from>"` with `<to>` in composer.json (preserves formatting). */
export function editComposerConstraint(
  content: string,
  name: string,
  from: string,
  to: string,
): string {
  const re = new RegExp(`("${escapeRe(name)}"\\s*:\\s*")${escapeRe(from)}(")`);
  if (!re.test(content)) {
    throw new Error(`could not locate "${name}": "${from}" in composer.json`);
  }
  return content.replace(re, `$1${to}$2`);
}
