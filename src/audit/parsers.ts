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

/** go.sum — `module vX.Y.Z[/go.mod] h1:hash`. Versions stored without the `v` (OSV form). */
export function parseGoSum(content: string): LockPackage[] {
  const out: LockPackage[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^(\S+)\s+v(\S+?)(?:\/go\.mod)?\s+h1:/.exec(line);
    if (m) out.push({ name: m[1]!, version: m[2]! });
  }
  return dedupe(out);
}

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
