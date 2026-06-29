import type { Versioning, VersionDiff } from "./types.js";

interface Pep440Parsed {
  epoch: number;
  release: number[];
  pre: [number, number] | null; // [stageRank a=0,b=1,rc=2, number]
  post: number | null;
  dev: number | null;
}

const PATTERN =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)([-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?([-_.]?(?:post|rev|r)[-_.]?\d*|-\d+)?([-_.]?dev[-_.]?\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?\s*$/i;

function stageRank(s: string): number {
  if (/^a|alpha/.test(s)) return 0;
  if (/^b|beta/.test(s)) return 1;
  return 2; // c, rc, pre, preview
}

function num(s: string | undefined): number {
  const m = /\d+/.exec(s ?? "");
  return m ? Number(m[0]) : 0;
}

export function parsePep440(input: string): Pep440Parsed | null {
  const m = PATTERN.exec(input.trim().toLowerCase());
  if (!m) return null;
  const epoch = m[1] ? Number(m[1]) : 0;
  const release = m[2]!.split(".").map(Number);

  let pre: [number, number] | null = null;
  if (m[3]) {
    const stage = /[a-z]+/.exec(m[3])![0];
    pre = [stageRank(stage), num(m[3])];
  }
  const post = m[4] ? num(m[4]) : null;
  const dev = m[5] ? num(m[5]) : null;
  return { epoch, release, pre, post, dev };
}

function trimZeros(r: number[]): number[] {
  const out = [...r];
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return out;
}

function compareArrays(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// PEP 440 ordering key per component, following the packaging library's algorithm.
const NEG = -1;
const POS = 1;

function preKey(p: Pep440Parsed): { kind: number; tuple?: [number, number] } {
  if (p.pre == null && p.post == null && p.dev != null) return { kind: NEG };
  if (p.pre == null) return { kind: POS };
  return { kind: 0, tuple: p.pre };
}

function comparePre(a: Pep440Parsed, b: Pep440Parsed): number {
  const ka = preKey(a);
  const kb = preKey(b);
  if (ka.kind !== kb.kind) return ka.kind < kb.kind ? -1 : 1;
  if (ka.tuple && kb.tuple) {
    if (ka.tuple[0] !== kb.tuple[0]) return ka.tuple[0] < kb.tuple[0] ? -1 : 1;
    if (ka.tuple[1] !== kb.tuple[1]) return ka.tuple[1] < kb.tuple[1] ? -1 : 1;
  }
  return 0;
}

export function comparePep440(av: string, bv: string): number {
  const a = parsePep440(av);
  const b = parsePep440(bv);
  if (!a || !b) return av === bv ? 0 : av < bv ? -1 : 1;

  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  const rel = compareArrays(trimZeros(a.release), trimZeros(b.release));
  if (rel !== 0) return rel;
  const pre = comparePre(a, b);
  if (pre !== 0) return pre;
  // post: absent sorts before present
  const ap = a.post ?? NEG * Infinity;
  const bp = b.post ?? NEG * Infinity;
  if (ap !== bp) return ap < bp ? -1 : 1;
  // dev: absent sorts after present
  const ad = a.dev ?? POS * Infinity;
  const bd = b.dev ?? POS * Infinity;
  if (ad !== bd) return ad < bd ? -1 : 1;
  return 0;
}

function satisfiesOne(version: string, spec: string): boolean {
  const m = /^(===|==|!=|~=|>=|<=|>|<)\s*(.+)$/.exec(spec.trim());
  if (!m) return false;
  const op = m[1]!;
  const ref = m[2]!.replace(/\.\*$/, ""); // tolerate ==1.4.*
  const c = comparePep440(version, ref);
  switch (op) {
    case "==":
    case "===":
      return spec.includes(".*") ? version.startsWith(ref) : c === 0;
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
    case "~=": {
      // compatible release: >= ref AND same release up to the last-but-one segment
      const refRel = parsePep440(ref)?.release ?? [];
      const upper = refRel.slice(0, -1);
      const verRel = parsePep440(version)?.release ?? [];
      const samePrefix = upper.every((n, i) => verRel[i] === n);
      return c >= 0 && samePrefix;
    }
    default:
      return false;
  }
}

export const pep440Versioning: Versioning = {
  id: "pep440",
  isValid: (v) => parsePep440(v) != null,
  isStable: (v) => {
    const p = parsePep440(v);
    return p != null && p.pre == null && p.dev == null;
  },
  compare: comparePep440,
  isGreaterThan: (a, b) => comparePep440(a, b) > 0,
  equals: (a, b) => comparePep440(a, b) === 0,
  satisfies: (version, range) =>
    range
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .every((s) => satisfiesOne(version, s)),
  diff: (from, to): VersionDiff => {
    const a = parsePep440(from);
    const b = parsePep440(to);
    if (!a || !b) return from === to ? "none" : "unknown";
    const cmp = comparePep440(from, to);
    if (cmp === 0) return "none";
    const ra = a.release;
    const rb = b.release;
    if ((ra[0] ?? 0) !== (rb[0] ?? 0)) return "major";
    if ((ra[1] ?? 0) !== (rb[1] ?? 0)) return "minor";
    return "patch";
  },
  maxSatisfying(versions, range) {
    const ok = versions.filter((v) => this.isStable(v) && this.satisfies(v, range));
    if (ok.length === 0) return null;
    return ok.reduce((max, v) => (comparePep440(v, max) > 0 ? v : max));
  },
};
