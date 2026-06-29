import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { editPackageJsonRange } from "../adapters/npm/range.js";
import { resolveUpdate } from "./ladder.js";
import { regeneratePnpmLockfile } from "./pnpm-cli.js";
import type { NpmPackageManager } from "./pm-detect.js";
import type { PackageChange, ResolvedFile } from "./types.js";

export interface NpmFamilyResolveResult {
  status: "resolved" | "resolved-cobump" | "unsolvable";
  changes: PackageChange[];
  /** Files written in the workdir (package.json + lockfile), to commit. */
  files: ResolvedFile[];
  /** Non-fatal warnings (e.g. pnpm unmet peers). */
  warnings: string[];
  reason?: string;
}

export interface ResolveRequest {
  workdir: string;
  name: string;
  fromRange: string;
  toRange: string;
}

export interface NpmFamilyResolver {
  pm: NpmPackageManager;
  /** Lockfiles to seed into the workdir and to commit back. */
  lockfileNames: string[];
  resolve(req: ResolveRequest): Promise<NpmFamilyResolveResult>;
}

async function readIfExists(dir: string, name: string): Promise<ResolvedFile | null> {
  try {
    await access(path.join(dir, name));
    return { name, content: await readFile(path.join(dir, name), "utf8") };
  } catch {
    return null;
  }
}

/** npm: full ladder (direct → iterative co-bump → unsolvable). */
const npmResolver: NpmFamilyResolver = {
  pm: "npm",
  lockfileNames: ["package-lock.json", "npm-shrinkwrap.json"],
  async resolve(req) {
    const outcome = await resolveUpdate(req);
    if (outcome.status === "unsolvable") {
      return { status: "unsolvable", changes: [], files: [], warnings: [], reason: outcome.reason };
    }
    return { status: outcome.status, changes: outcome.changes, files: outcome.files, warnings: [] };
  },
};

/** pnpm: direct lockfile regeneration; peer conflicts surface as warnings. */
const pnpmResolver: NpmFamilyResolver = {
  pm: "pnpm",
  lockfileNames: ["pnpm-lock.yaml"],
  async resolve(req) {
    const pkgPath = path.join(req.workdir, "package.json");
    const original = await readFile(pkgPath, "utf8");
    await writeFile(pkgPath, editPackageJsonRange(original, req.name, req.fromRange, req.toRange));

    const result = await regeneratePnpmLockfile(req.workdir);
    if (!result.ok) {
      return {
        status: "unsolvable",
        changes: [],
        files: [],
        warnings: result.warnings,
        reason: result.stderr.split("\n").filter(Boolean).slice(-6).join("\n").trim(),
      };
    }
    const files: ResolvedFile[] = [];
    const pkg = await readIfExists(req.workdir, "package.json");
    if (pkg) files.push(pkg);
    const lock = await readIfExists(req.workdir, "pnpm-lock.yaml");
    if (lock) files.push(lock);

    return {
      status: "resolved",
      changes: [{ name: req.name, fromRange: req.fromRange, toRange: req.toRange, cobump: false }],
      files,
      warnings: result.warnings,
    };
  },
};

const RESOLVERS: Record<string, NpmFamilyResolver> = {
  npm: npmResolver,
  pnpm: pnpmResolver,
};

export function getResolver(pm: NpmPackageManager): NpmFamilyResolver | null {
  return RESOLVERS[pm] ?? null;
}
