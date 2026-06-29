import type { Versioning, VersionDiff } from "./types.js";

type Segment = number | string;

/** Split a gem version into segments, separating digits and letters. */
function segments(v: string): Segment[] {
  const out: Segment[] = [];
  for (const m of v.trim().matchAll(/[0-9]+|[a-zA-Z]+/g)) {
    const tok = m[0]!;
    out.push(/^\d+$/.test(tok) ? Number(tok) : tok);
  }
  return out;
}

/** Gem::Version comparison: letter segments are prereleases and sort first. */
export function compareGem(av: string, bv: string): number {
  const a = segments(av);
  const b = segments(bv);
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const lhs: Segment = a[i] ?? 0;
    const rhs: Segment = b[i] ?? 0;
    if (lhs === rhs) continue;
    const ls = typeof lhs === "string";
    const rs = typeof rhs === "string";
    if (ls && !rs) return -1; // string (prerelease) < number
    if (!ls && rs) return 1;
    if (ls && rs) return (lhs as string) < (rhs as string) ? -1 : 1;
    return (lhs as number) < (rhs as number) ? -1 : 1;
  }
  return 0;
}

function numericPrefix(v: string): number[] {
  const out: number[] = [];
  for (const s of segments(v)) {
    if (typeof s === "number") out.push(s);
    else break;
  }
  return out;
}

/** Pessimistic `~>` upper bound: increment the second-to-last given segment. */
function pessimisticUpper(ref: string): number[] {
  const seg = numericPrefix(ref);
  if (seg.length <= 1) return [(seg[0] ?? 0) + 1];
  const upper = seg.slice(0, -1);
  upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
  return upper;
}

function compareArr(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function satisfiesOne(version: string, req: string): boolean {
  const m = /^(~>|>=|<=|!=|=|>|<)?\s*(.+)$/.exec(req.trim());
  if (!m) return false;
  const op = m[1] ?? "=";
  const ref = m[2]!.trim();
  const c = compareGem(version, ref);
  switch (op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case "~>":
      return c >= 0 && compareArr(numericPrefix(version), pessimisticUpper(ref)) < 0;
    default:
      return false;
  }
}

export const gemVersioning: Versioning = {
  id: "gem",
  isValid: (v) => /\d/.test(v) && /^[0-9a-zA-Z.\-]+$/.test(v.trim()),
  isStable: (v) => !/[a-zA-Z]/.test(v),
  compare: compareGem,
  isGreaterThan: (a, b) => compareGem(a, b) > 0,
  equals: (a, b) => compareGem(a, b) === 0,
  satisfies: (version, range) =>
    range
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .every((s) => satisfiesOne(version, s)),
  diff: (from, to): VersionDiff => {
    if (compareGem(from, to) === 0) return "none";
    const a = numericPrefix(from);
    const b = numericPrefix(to);
    if ((a[0] ?? 0) !== (b[0] ?? 0)) return "major";
    if ((a[1] ?? 0) !== (b[1] ?? 0)) return "minor";
    return "patch";
  },
  maxSatisfying(versions, range) {
    const ok = versions.filter((v) => this.isStable(v) && this.satisfies(v, range));
    if (ok.length === 0) return null;
    return ok.reduce((max, v) => (compareGem(v, max) > 0 ? v : max));
  },
};
