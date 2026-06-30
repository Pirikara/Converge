import type { DependencyEntry } from "../types.js";

interface CatalogLib {
  name: string; // group:artifact
  version: string;
  /** Offset span of the editable version literal (in [versions] for refs). */
  valueStart: number;
  valueEnd: number;
}

/** Absolute offset of capture group 1, assuming it occurs once in the match. */
function groupOffset(lineStart: number, m: RegExpExecArray): number {
  return lineStart + m.index + m[0].indexOf(m[1]!);
}

/**
 * Locate library coordinates + their editable version literal in a Gradle
 * version catalog (libs.versions.toml). Handles `[versions]` refs, inline
 * `version = "…"`, `group`/`name` pairs, and `"g:a:v"` shorthand strings.
 * Single-line entries (the catalog convention).
 */
function findCatalogLibs(content: string): CatalogLib[] {
  const lines = content.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }

  // Pass 1: [versions] table + raw [libraries] lines.
  const versions = new Map<string, { value: string; start: number; end: number }>();
  const libLines: { text: string; start: number }[] = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section === "versions") {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/.exec(line);
      if (m) {
        const vs = starts[i]! + m.index + m[0].indexOf(m[2]!, m[0].indexOf("="));
        versions.set(m[1]!, { value: m[2]!, start: vs, end: vs + m[2]!.length });
      }
    } else if (section === "libraries") {
      if (line.trim()) libLines.push({ text: line, start: starts[i]! });
    }
  }

  // Pass 2: resolve each library line.
  const out: CatalogLib[] = [];
  for (const { text, start } of libLines) {
    // Shorthand string: name = "group:artifact:version"
    const str = /=\s*"([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)"/.exec(text);
    if (str) {
      const coord = str[1]!;
      const segs = coord.split(":");
      const version = segs[2]!;
      const coordStart = start + str.index + str[0].indexOf(coord);
      const vStart = coordStart + coord.lastIndexOf(":") + 1;
      out.push({ name: `${segs[0]}:${segs[1]}`, version, valueStart: vStart, valueEnd: vStart + version.length });
      continue;
    }

    // Inline table: module / group+name + version / version.ref
    const moduleM = /\bmodule\s*=\s*"([^"]+)"/.exec(text);
    const groupM = /\bgroup\s*=\s*"([^"]+)"/.exec(text);
    const nameM = /\bname\s*=\s*"([^"]+)"/.exec(text);
    let coord: string | null = null;
    if (moduleM) coord = moduleM[1]!;
    else if (groupM && nameM) coord = `${groupM[1]}:${nameM[1]}`;
    if (!coord || !coord.includes(":")) continue;

    const refM = /\bversion\.ref\s*=\s*"([^"]+)"/.exec(text);
    if (refM) {
      const v = versions.get(refM[1]!);
      if (v) out.push({ name: coord, version: v.value, valueStart: v.start, valueEnd: v.end });
      continue;
    }
    const inlineM = /\bversion\s*=\s*"([^"]+)"/.exec(text);
    if (inlineM) {
      const vStart = groupOffset(start, inlineM);
      out.push({ name: coord, version: inlineM[1]!, valueStart: vStart, valueEnd: vStart + inlineM[1]!.length });
    }
  }
  return out;
}

/** Parse library coordinates + resolved versions from a Gradle version catalog. */
export function parseVersionCatalog(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  for (const lib of findCatalogLibs(content)) {
    if (!/^\d/.test(lib.version)) continue; // skip refs that didn't resolve to a version
    const key = `${lib.name}@${lib.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: lib.name, range: lib.version, kind: "prod" });
  }
  return out;
}

/** Replace the editable version literal for `name` (currently `from`) with `to`. */
export function editVersionCatalog(content: string, name: string, from: string, to: string): string {
  for (const lib of findCatalogLibs(content)) {
    if (lib.name === name && lib.version === from) {
      return content.slice(0, lib.valueStart) + to + content.slice(lib.valueEnd);
    }
  }
  throw new Error(`could not locate ${name} ${from} in version catalog`);
}
