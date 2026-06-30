import type { DependencyEntry } from "../types.js";

interface ChartDep {
  name: string | null;
  version: string | null;
  repository: string | null;
  /** Offset span of the version *value* (quotes excluded), or -1 if unset. */
  vStart: number;
  vEnd: number;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Parse a `key: value` field into `dep`, recording the version value's offset. */
function parseField(text: string, lineStart: number, dep: ChartDep): void {
  const m = /^(\s*)(name|version|repository):[ \t]*(.*)$/.exec(text);
  if (!m) return;
  const key = m[2]!;
  const afterColonIdx = m[1]!.length + m[2]!.length + 1;
  const after = text.slice(afterColonIdx);
  const lead = after.length - after.trimStart().length;
  let v = after.trimStart();
  let quoteOffset = 0;
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    const end = v.indexOf(q, 1);
    v = v.slice(1, end === -1 ? undefined : end);
    quoteOffset = 1;
  } else {
    v = v.replace(/\s+#.*$/, "").trim();
  }
  if (key === "name") dep.name = v;
  else if (key === "repository") dep.repository = v;
  else {
    dep.version = v;
    dep.vStart = lineStart + afterColonIdx + lead + quoteOffset;
    dep.vEnd = dep.vStart + v.length;
  }
}

/** Locate dependency entries in a Chart.yaml, tracking version value offsets. */
function findChartDeps(content: string): ChartDep[] {
  const lines = content.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }

  let di = -1;
  let depIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)dependencies:\s*(#.*)?$/.exec(lines[i]!.replace(/\r$/, ""));
    if (m) {
      di = i;
      depIndent = m[1]!.length;
      break;
    }
  }
  if (di === -1) return [];

  const deps: ChartDep[] = [];
  let cur: ChartDep | null = null;
  for (let i = di + 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (indentOf(line) <= depIndent) break; // dependencies block ended

    const dash = /^(\s*)-[ \t]?(.*)$/.exec(line);
    if (dash) {
      if (cur) deps.push(cur);
      cur = { name: null, version: null, repository: null, vStart: -1, vEnd: -1 };
      const rest = dash[2]!;
      if (rest) parseField(rest, starts[i]! + (line.length - rest.length), cur);
    } else if (cur) {
      parseField(line, starts[i]!, cur);
    }
  }
  if (cur) deps.push(cur);
  return deps.filter((d) => d.name && d.version);
}

/**
 * Parse Helm chart dependencies from a Chart.yaml `dependencies:` list. The
 * dependency `name` is the chart name, `version` its constraint, and the
 * http(s) `repository` is carried for the datasource. Line-based (no YAML dep).
 */
export function parseChart(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  for (const d of findChartDeps(content)) {
    const repo = d.repository ?? "";
    // Only registry repos with an index.yaml are resolvable here.
    if (!/^https?:\/\//.test(repo)) continue;
    const key = `${d.name}@${d.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: d.name!, range: d.version!, kind: "prod", repository: repo });
  }
  return out;
}

/** Replace the version of the dependency `name` (currently `from`) with `to`. */
export function editChartVersion(content: string, name: string, from: string, to: string): string {
  for (const d of findChartDeps(content)) {
    if (d.name === name && d.version === from && d.vStart >= 0) {
      return content.slice(0, d.vStart) + to + content.slice(d.vEnd);
    }
  }
  throw new Error(`could not locate dependency ${name} ${from} in Chart.yaml`);
}
