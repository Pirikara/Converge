import type { LockPackage } from "./lockfile-npm.js";

function dedupe(pkgs: LockPackage[]): LockPackage[] {
  const seen = new Set<string>();
  const out: LockPackage[] = [];
  for (const p of pkgs) {
    const k = `${p.name}@${p.version}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** composer.lock — `packages` + `packages-dev` arrays of `{ name, version }`. */
export function parseComposerLock(content: string): LockPackage[] {
  const out: LockPackage[] = [];
  let data: { packages?: unknown; "packages-dev"?: unknown };
  try {
    data = JSON.parse(content) as typeof data;
  } catch {
    return out;
  }
  for (const key of ["packages", "packages-dev"] as const) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr as { name?: unknown; version?: unknown }[]) {
      if (typeof p.name === "string" && typeof p.version === "string") {
        // Packagist/OSV versions are normalized without a leading `v`.
        out.push({ name: p.name, version: p.version.replace(/^v/, "") });
      }
    }
  }
  return dedupe(out);
}

/** pnpm-lock.yaml — package keys `name@version:` / `'@scope/name@version(peers)':`. */
export function parsePnpmLock(content: string): LockPackage[] {
  const re = /^\s{2,}'?((?:@[\w.-]+\/)?[\w.-]+)@([0-9][\w.\-+]*)(?:\([^)]*\))?'?:/;
  const out: LockPackage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) out.push({ name: m[1]!, version: m[2]! });
  }
  return dedupe(out);
}

/** yarn.lock — Berry (`name@npm:range:` + `version: x`) and Classic (`name@range:` + `version "x"`). */
export function parseYarnLock(content: string): LockPackage[] {
  const out: LockPackage[] = [];
  let name: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (/^[^\s#"]/.test(line) || /^"/.test(line)) {
      // descriptor key line (column 0), possibly comma-joined; take the first
      const key = line.replace(/:\s*$/, "").split(",")[0]!.trim().replace(/^"|"$/g, "");
      name = nameFromYarnDescriptor(key);
    } else {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m && name) out.push({ name, version: m[1]! });
    }
  }
  return dedupe(out);
}

function nameFromYarnDescriptor(key: string): string | null {
  // "@scope/name@npm:^1" -> "@scope/name"; "lodash@^4" -> "lodash"
  const at = key.indexOf("@", 1);
  if (at <= 0) return null;
  return key.slice(0, at);
}

/**
 * bun.lock (lockfileVersion 1) — JSONC (trailing commas). `packages` maps a key
 * to an array whose first element is `"name@version"` (e.g.
 * `"is-odd": ["is-odd@3.0.1", …]`). Scoped names keep their leading `@`.
 */
export function parseBunLock(content: string): LockPackage[] {
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/,(\s*[}\]])/g, "$1")); // strip trailing commas
  } catch {
    return [];
  }
  const pkgs = (data as { packages?: Record<string, unknown> })?.packages;
  if (!pkgs || typeof pkgs !== "object") return [];
  const out: LockPackage[] = [];
  for (const v of Object.values(pkgs)) {
    const spec = Array.isArray(v) ? v[0] : undefined;
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue; // no version, or only a leading-@ scope
    out.push({ name: spec.slice(0, at), version: spec.slice(at + 1) });
  }
  return dedupe(out);
}

/** go.sum — `module vX.Y.Z[/go.mod] h1:hash`. Versions stored without the `v` (OSV form). */
export function parseGoSum(content: string): LockPackage[] {
  const out: LockPackage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^(\S+)\s+v(\S+?)(?:\/go\.mod)?\s+h1:/.exec(line);
    if (m) out.push({ name: m[1]!, version: m[2]! });
  }
  return dedupe(out);
}

/** TOML lockfiles with `[[package]]` blocks (Cargo.lock, poetry.lock, uv.lock). */
export function parseTomlLockPackages(content: string): LockPackage[] {
  const out: LockPackage[] = [];
  let name: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      name = null;
      continue;
    }
    const n = /^name = "(.+)"$/.exec(line);
    if (n) {
      name = n[1]!;
      continue;
    }
    const v = /^version = "(.+)"$/.exec(line);
    if (v && name) {
      out.push({ name, version: v[1]! });
      name = null;
    }
  }
  return dedupe(out);
}

/** Cargo.lock (alias of the shared TOML `[[package]]` parser). */
export const parseCargoLock = parseTomlLockPackages;

/** Gemfile.lock — `specs:` lists every resolved gem; `DEPENDENCIES` lists direct gems. */
export function parseGemfileLock(content: string): { packages: LockPackage[]; directs: Set<string> } {
  const packages: LockPackage[] = [];
  const directs = new Set<string>();
  let inSpecs = false;
  let inDeps = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // a top-level section header (GEM, PLATFORMS, DEPENDENCIES, ...)
      inSpecs = false;
      inDeps = /^DEPENDENCIES/.test(line);
      continue;
    }
    if (/^ {2}specs:/.test(line)) {
      inSpecs = true;
      continue;
    }
    if (inSpecs) {
      const m = /^ {4}(\S+) \(([0-9][\w.]*)\)$/.exec(line);
      if (m) packages.push({ name: m[1]!, version: m[2]! });
    } else if (inDeps) {
      const m = /^ {2}(\S+)/.exec(line);
      if (m) directs.add(m[1]!.replace(/!$/, ""));
    }
  }
  return { packages: dedupe(packages), directs };
}
