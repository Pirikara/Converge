import type { DependencyEntry } from "../types.js";

export interface GemRequirement extends DependencyEntry {
  /** Exact version when the only requirement is `= x` / a bare `'x'`. */
  pin: string | null;
}

/** A single comma-joined requirement string is an exact pin only when `= x`. */
export function gemPin(req: string): string | null {
  const trimmed = req.trim();
  if (req.includes(",")) return null; // compound
  const m = /^(?:=\s*)?(\d[\w.]*)$/.exec(trimmed);
  return m ? m[1]! : null;
}

/**
 * Parse `gem` declarations from a Gemfile (best-effort). Captures the gem name
 * and its version requirement(s); skips groups/sources/options. Version-less
 * gems and git/path gems are surfaced with an empty range.
 */
export function parseGemfile(content: string): GemRequirement[] {
  const out: GemRequirement[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("gem ")) continue;
    if (/\b(?:git|github|path):\s*/.test(line)) continue; // out of scope

    const nameMatch = /^gem\s+['"]([^'"]+)['"]/.exec(line);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;

    // Version requirements are the quoted args after the name, before options (key:).
    const rest = line.slice(nameMatch[0].length);
    const reqs: string[] = [];
    for (const m of rest.matchAll(/['"]([^'"]+)['"]/g)) {
      const val = m[1]!;
      if (/^[<>=~!]|^\d/.test(val.trim())) reqs.push(val.trim());
    }
    const range = reqs.join(", ");
    out.push({ name, range, kind: "prod", pin: range ? gemPin(range) : null });
  }
  return out;
}
