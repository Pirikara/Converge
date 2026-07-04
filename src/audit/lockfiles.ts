import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseNpmLockTree, type LockPackage } from "./lockfile-npm.js";
import { parsePnpmLock, parseYarnLock, parseBunLock, parseGoSum, parseGemfileLock, parseCargoLock, parseTomlLockPackages, parseComposerLock } from "./parsers.js";
import { parseGoMod } from "../adapters/gomod/gomod.js";
import { parseCargoToml } from "../adapters/cargo/cargo-toml.js";
import { parsePyproject } from "../adapters/pyproject/parse.js";

export interface EnumeratedLock {
  file: string;
  /** OSV ecosystem name. */
  ecosystem: string;
  packages: LockPackage[];
  directs: Set<string>;
}

/** Parse a lockfile's full tree given its filename + content (no IO). */
export function parseLockfile(
  name: string,
  content: string,
): { ecosystem: string; packages: LockPackage[] } | null {
  const base = name.split("/").pop() ?? name;
  switch (base) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return { ecosystem: "npm", packages: parseNpmLockTree(content) };
    case "pnpm-lock.yaml":
      return { ecosystem: "npm", packages: parsePnpmLock(content) };
    case "yarn.lock":
      return { ecosystem: "npm", packages: parseYarnLock(content) };
    case "bun.lock":
      return { ecosystem: "npm", packages: parseBunLock(content) };
    case "go.sum":
      return { ecosystem: "Go", packages: parseGoSum(content) };
    case "Gemfile.lock":
      return { ecosystem: "RubyGems", packages: parseGemfileLock(content).packages };
    case "Cargo.lock":
      return { ecosystem: "crates.io", packages: parseCargoLock(content) };
    case "poetry.lock":
    case "uv.lock":
      return { ecosystem: "PyPI", packages: parseTomlLockPackages(content) };
    case "composer.lock":
      return { ecosystem: "Packagist", packages: parseComposerLock(content) };
    default:
      return null;
  }
}

async function read(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function npmDirects(dir: string): Promise<Set<string>> {
  const c = await read(path.join(dir, "package.json"));
  const s = new Set<string>();
  if (c) {
    try {
      const p = JSON.parse(c) as Record<string, Record<string, string>>;
      for (const b of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const n of Object.keys(p[b] ?? {})) s.add(n);
      }
    } catch {
      /* ignore */
    }
  }
  return s;
}

/** Direct deps from composer.json `require` + `require-dev` (excl. php/ext-*). */
async function composerDirects(dir: string): Promise<Set<string>> {
  const c = await read(path.join(dir, "composer.json"));
  const s = new Set<string>();
  if (c) {
    try {
      const p = JSON.parse(c) as Record<string, Record<string, string>>;
      for (const b of ["require", "require-dev"]) {
        for (const n of Object.keys(p[b] ?? {})) {
          if (n === "php" || n.startsWith("ext-") || n.startsWith("lib-") || !n.includes("/")) continue;
          s.add(n);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return s;
}

/** Detect and enumerate every supported lockfile tree in a directory. */
export async function enumerateLocks(dir: string): Promise<EnumeratedLock[]> {
  const out: EnumeratedLock[] = [];

  // npm family → OSV ecosystem "npm" (one lockfile per project)
  const [pl, pnpm, yarn, bun] = await Promise.all([
    read(path.join(dir, "package-lock.json")),
    read(path.join(dir, "pnpm-lock.yaml")),
    read(path.join(dir, "yarn.lock")),
    read(path.join(dir, "bun.lock")),
  ]);
  if (pl || pnpm || yarn || bun) {
    const directs = await npmDirects(dir);
    if (pl) out.push({ file: "package-lock.json", ecosystem: "npm", packages: parseNpmLockTree(pl), directs });
    else if (pnpm) out.push({ file: "pnpm-lock.yaml", ecosystem: "npm", packages: parsePnpmLock(pnpm), directs });
    else if (yarn) out.push({ file: "yarn.lock", ecosystem: "npm", packages: parseYarnLock(yarn), directs });
    else if (bun) out.push({ file: "bun.lock", ecosystem: "npm", packages: parseBunLock(bun), directs });
  }

  // RubyGems
  const gl = await read(path.join(dir, "Gemfile.lock"));
  if (gl) {
    const { packages, directs } = parseGemfileLock(gl);
    out.push({ file: "Gemfile.lock", ecosystem: "RubyGems", packages, directs });
  }

  // Go
  const gs = await read(path.join(dir, "go.sum"));
  if (gs) {
    const directs = new Set<string>();
    const gm = await read(path.join(dir, "go.mod"));
    if (gm) for (const r of parseGoMod(gm)) if (!r.indirect) directs.add(r.name);
    out.push({ file: "go.sum", ecosystem: "Go", packages: parseGoSum(gs), directs });
  }

  // Cargo
  const cl = await read(path.join(dir, "Cargo.lock"));
  if (cl) {
    const directs = new Set<string>();
    const ct = await read(path.join(dir, "Cargo.toml"));
    if (ct) for (const d of parseCargoToml(ct)) directs.add(d.name);
    out.push({ file: "Cargo.lock", ecosystem: "crates.io", packages: parseCargoLock(cl), directs });
  }

  // Composer (PHP) → Packagist
  const cmp = await read(path.join(dir, "composer.lock"));
  if (cmp) {
    out.push({
      file: "composer.lock",
      ecosystem: "Packagist",
      packages: parseComposerLock(cmp),
      directs: await composerDirects(dir),
    });
  }

  // Python project lockfiles (poetry / uv) → PyPI
  const [poetry, uv] = await Promise.all([
    read(path.join(dir, "poetry.lock")),
    read(path.join(dir, "uv.lock")),
  ]);
  if (poetry || uv) {
    const directs = new Set<string>();
    const pp = await read(path.join(dir, "pyproject.toml"));
    if (pp) for (const d of parsePyproject(pp)) directs.add(d.name);
    const lock = (poetry ?? uv)!;
    out.push({
      file: poetry ? "poetry.lock" : "uv.lock",
      ecosystem: "PyPI",
      packages: parseTomlLockPackages(lock),
      directs,
    });
  }

  return out;
}
