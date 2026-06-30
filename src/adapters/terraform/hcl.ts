import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Index just past the `}` matching the `{` at `openIdx`, aware of strings and
 * `#` / `//` line comments so braces inside them don't throw off the depth.
 */
function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "#" || (ch === "/" && s[i + 1] === "/")) {
      const nl = s.indexOf("\n", i);
      if (nl === -1) return s.length;
      i = nl;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

interface Block {
  body: string;
  /** Body offsets within the string `iterBlocks` was given. */
  bodyStart: number;
  bodyEnd: number;
  groups: RegExpExecArray;
}

/** Iterate `{ ... }` blocks whose opening is matched by `headerRe` (must end `\{`). */
function* iterBlocks(content: string, headerRe: RegExp): Generator<Block> {
  headerRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content))) {
    const openIdx = content.indexOf("{", m.index + m[0].length - 1);
    if (openIdx === -1) break;
    const end = matchBrace(content, openIdx);
    yield { body: content.slice(openIdx + 1, end - 1), bodyStart: openIdx + 1, bodyEnd: end - 1, groups: m };
    headerRe.lastIndex = end;
  }
}

/** First `key = "value"` scalar in a block body. */
function scalar(body: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(body);
  return m ? m[1]! : null;
}

const PROVIDER_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+$/; // namespace/type
const MODULE_RE = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/; // namespace/name/system
const REQUIRED_PROVIDERS = /required_providers\s*\{/g;
const PROVIDER_ENTRY = /(?:^|\n)[ \t]*[A-Za-z0-9_-]+\s*=\s*\{/g;
const MODULE_BLOCK = /(?:^|\n)[ \t]*module\s+"[^"]+"\s*\{/g;

/**
 * Parse Terraform registry dependencies from `.tf` files:
 *  - providers in `required_providers { name = { source, version } }`
 *  - registry `module "x" { source = "ns/name/system", version }`
 * Git/local/custom-host module sources (no public-registry shape) are skipped,
 * as are providers without a `namespace/type` source. Line-based + brace-aware;
 * no HCL dependency. The `source` is the dependency name; `version` the range.
 */
export function parseTerraform(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, range: string) => {
    const k = `${name}@${range}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name, range, kind: "prod" });
  };

  for (const rp of iterBlocks(content, REQUIRED_PROVIDERS)) {
    for (const prov of iterBlocks(rp.body, PROVIDER_ENTRY)) {
      const source = scalar(prov.body, "source");
      const version = scalar(prov.body, "version");
      if (source && version && PROVIDER_RE.test(source)) add(source, version);
    }
  }
  for (const mod of iterBlocks(content, MODULE_BLOCK)) {
    const source = scalar(mod.body, "source");
    const version = scalar(mod.body, "version");
    if (source && version && MODULE_RE.test(source)) add(source, version);
  }
  return out;
}

/** Replace `version = "<fromC>"` in the block whose `source` is `name`. */
export function editTerraformVersion(
  content: string,
  name: string,
  fromC: string,
  toC: string,
): string {
  const verRe = new RegExp(`(version\\s*=\\s*")${escapeRe(fromC)}(")`);
  const apply = (absStart: number, absEnd: number, body: string): string =>
    content.slice(0, absStart) + body.replace(verRe, `$1${toC}$2`) + content.slice(absEnd);

  for (const rp of iterBlocks(content, REQUIRED_PROVIDERS)) {
    for (const prov of iterBlocks(rp.body, PROVIDER_ENTRY)) {
      if (scalar(prov.body, "source") === name && verRe.test(prov.body)) {
        return apply(rp.bodyStart + prov.bodyStart, rp.bodyStart + prov.bodyEnd, prov.body);
      }
    }
  }
  for (const mod of iterBlocks(content, MODULE_BLOCK)) {
    if (scalar(mod.body, "source") === name && verRe.test(mod.body)) {
      return apply(mod.bodyStart, mod.bodyEnd, mod.body);
    }
  }
  throw new Error(`could not locate version "${fromC}" for ${name} in Terraform file`);
}
