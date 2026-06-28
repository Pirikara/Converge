import type { DependencyEntry } from "../types.js";

export interface ParsedRequirement extends DependencyEntry {
  /** Extras, e.g. ["standard"] from uvicorn[standard]. */
  extras: string[];
  /** Exact pin version when the spec is a single `==x`, else null. */
  pin: string | null;
}

/** Pull the pinned version out of a specifier like "==1.0.8". */
export function parsePin(spec: string): string | null {
  const m = /^==\s*([0-9][^,;\s]*)$/.exec(spec.trim());
  return m ? m[1]! : null;
}

/**
 * Parse a requirements.txt into dependency entries (best-effort, PEP 508-lite).
 * Skips option lines (-r/-e/--hash/-c/index-url), URL/VCS requirements, and
 * comments; strips inline comments and environment markers.
 */
export function parseRequirements(content: string): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("-")) continue; // -r, -e, -c, --hash, --index-url, ...
    // URL / VCS / direct-reference requirements are out of scope for now.
    if (line.includes("://") || /\s@\s/.test(line)) continue;

    // Strip inline comment (" #...") and environment marker ("; ...").
    line = line.split(/\s+#/)[0]!.trim();
    line = line.split(";")[0]!.trim();
    if (!line) continue;

    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const extras = m[2]
      ? m[2].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const spec = (m[3] ?? "").trim();

    out.push({
      name,
      range: spec,
      kind: "prod",
      extras,
      pin: parsePin(spec),
    });
  }
  return out;
}
