import type { DependencyEntry } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A 40-char hex commit SHA (actions can be pinned to one). */
function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Branch refs we never treat as updatable versions. */
const BRANCH_REFS = new Set(["main", "master", "latest", "develop", "dev"]);

/**
 * Parse `uses: owner/repo@ref` references from a workflow / composite-action
 * YAML file. The action repo (`owner/repo`, subpath stripped) is the dependency
 * name; the git ref (tag) is its "range". Skips:
 *  - local actions (`./...`) and Docker actions (`docker://...`)
 *  - SHA-pinned refs (need commit resolution — handled in a later slice)
 *  - branch refs (`@main`, `@master`)
 *  - reusable workflow calls without a version
 *
 * Line-based (no YAML dependency); `uses:` is always a scalar so this is robust.
 */
export function parseWorkflow(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();

  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?/.exec(raw);
    if (!m) continue;
    const use = m[1]!;
    if (use.startsWith("./") || use.startsWith("../") || use.startsWith(".\\")) continue; // local
    if (use.startsWith("docker://")) continue; // docker action

    const at = use.indexOf("@");
    if (at === -1) continue; // no version pinned
    const ref = use.slice(at + 1);
    if (!ref || isSha(ref) || BRANCH_REFS.has(ref.toLowerCase())) continue;

    // owner/repo[/subpath] → name is the first two segments.
    const target = use.slice(0, at);
    const segs = target.split("/");
    if (segs.length < 2) continue; // not an owner/repo action
    const name = `${segs[0]}/${segs[1]}`;

    const key = `${name}@${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, range: ref, kind: "prod" });
  }
  return out;
}

/**
 * Replace an action's pinned ref across all `uses:` lines for `name` that
 * currently point at `fromRef`. Preserves any subpath (`owner/repo/path@ref`).
 */
export function editActionRef(
  content: string,
  name: string,
  fromRef: string,
  toRef: string,
): string {
  const re = new RegExp(
    `(uses:\\s*["']?${escapeRe(name)}(?:/[^@"'\\s]+)?@)${escapeRe(fromRef)}(?=["'\\s#]|$)`,
    "g",
  );
  if (!re.test(content)) {
    throw new Error(`could not locate uses: ${name}@${fromRef} in workflow`);
  }
  return content.replace(re, `$1${toRef}`);
}
