import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { editPackageJsonRange, bumpRange } from "../adapters/npm/range.js";
import { findPeerCompatibleVersion } from "../adapters/npm/registry.js";
import {
  resolveLockfile as realResolveLockfile,
  isEresolve,
  type NpmRunResult,
} from "./npm-cli.js";
import { parseEresolve, describeConflict } from "./conflict.js";
import type {
  PackageChange,
  ResolveOutcome,
  ResolveRequest,
  ResolvedFile,
} from "./types.js";
import { log } from "../logger.js";

/** Injectable side effects, so the ladder can be unit-tested without network. */
export interface ResolveDeps {
  resolveLockfile: (dir: string) => Promise<NpmRunResult>;
  findPeerCompatibleVersion: (
    pkg: string,
    peerName: string,
    targetVersion: string,
  ) => Promise<string | null>;
}

const defaultDeps: ResolveDeps = {
  resolveLockfile: realResolveLockfile,
  findPeerCompatibleVersion,
};

const LOCK_FILES = ["package-lock.json", "npm-shrinkwrap.json"];

async function readWorkFiles(dir: string): Promise<ResolvedFile[]> {
  const files: ResolvedFile[] = [
    { name: "package.json", content: await readFile(path.join(dir, "package.json"), "utf8") },
  ];
  for (const lf of LOCK_FILES) {
    try {
      await access(path.join(dir, lf));
      files.push({ name: lf, content: await readFile(path.join(dir, lf), "utf8") });
    } catch {
      /* no lockfile */
    }
  }
  return files;
}

function currentRangeOf(pkgJson: string, name: string): string | null {
  const obj = JSON.parse(pkgJson) as Record<string, Record<string, string>>;
  for (const block of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const range = obj[block]?.[name];
    if (range) return range;
  }
  return null;
}

/**
 * F1 resolution ladder. Resolves a single dependency bump, escalating to an
 * automatic co-bump when a peer conflict blocks the direct update.
 *
 *  1. direct  — edit the range, regenerate the lockfile.
 *  2. co-bump — on ERESOLVE, find a version of the conflicting package whose
 *               peer requirement admits the target, bump it too, retry.
 *  3. unsolvable — report the exact conflict for a human.
 */
export async function resolveUpdate(
  req: ResolveRequest,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolveOutcome> {
  const pkgPath = path.join(req.workdir, "package.json");
  const attempted: string[] = [];

  // --- Strategy 1: direct -------------------------------------------------
  attempted.push("direct");
  const original = await readFile(pkgPath, "utf8");
  const directContent = editPackageJsonRange(
    original,
    req.name,
    req.fromRange,
    req.toRange,
  );
  await writeFile(pkgPath, directContent);

  let result = await deps.resolveLockfile(req.workdir);
  const directChange: PackageChange = {
    name: req.name,
    fromRange: req.fromRange,
    toRange: req.toRange,
    cobump: false,
  };

  if (result.ok) {
    return {
      status: "resolved",
      strategy: "direct",
      changes: [directChange],
      files: await readWorkFiles(req.workdir),
    };
  }
  if (!isEresolve(result)) {
    return unsolvable("npm install failed (non-ERESOLVE error)", null, result, attempted);
  }

  // --- Strategy 2: iterative co-bump --------------------------------------
  // Each ERESOLVE names one offending package; co-bump it to a version whose
  // peer requirement admits the target, then re-resolve. Repeat until the tree
  // is satisfied or we can make no further progress (multi-package conflicts).
  const MAX_ITERATIONS = 8;
  let content = directContent;
  const changes: PackageChange[] = [directChange];
  const applied = new Map<string, string>();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const conflict = parseEresolve(result.stderr || result.stdout);
    log.debug(`conflict[${i}]: ${describeConflict(conflict)}`);

    if (!conflict.from || !conflict.peer || !conflict.found) {
      return unsolvable(describeConflict(conflict), conflict, result, attempted);
    }
    attempted.push(`co-bump(${conflict.from.name})`);

    const target = await deps.findPeerCompatibleVersion(
      conflict.from.name,
      conflict.peer.name,
      conflict.found.version,
    );
    if (!target) {
      return unsolvable(
        `no version of ${conflict.from.name} accepts ${conflict.peer.name}@${conflict.found.version} — ${describeConflict(conflict)}`,
        conflict,
        result,
        attempted,
      );
    }
    if (applied.get(conflict.from.name) === target) {
      // Re-deriving the same co-bump means we are not making progress.
      return unsolvable(`stuck on ${describeConflict(conflict)}`, conflict, result, attempted);
    }

    const fromRange = currentRangeOf(content, conflict.from.name);
    if (!fromRange) {
      // The imposing package is transitive (not a direct dependency); manifest
      // edits can't fix it — needs a human / source change (SPEC F1.2 case 3).
      return unsolvable(
        `transitive conflict: ${describeConflict(conflict)} (${conflict.from.name} is not a direct dependency)`,
        conflict,
        result,
        attempted,
      );
    }
    const toRange = bumpRange(fromRange, target);
    content = editPackageJsonRange(content, conflict.from.name, fromRange, toRange);
    await writeFile(pkgPath, content);
    applied.set(conflict.from.name, target);
    changes.push({ name: conflict.from.name, fromRange, toRange, cobump: true });

    result = await deps.resolveLockfile(req.workdir);
    if (result.ok) {
      return {
        status: "resolved-cobump",
        strategy: `co-bump×${changes.length - 1}`,
        changes,
        files: await readWorkFiles(req.workdir),
      };
    }
    if (!isEresolve(result)) {
      return unsolvable("npm install failed (non-ERESOLVE error)", null, result, attempted);
    }
  }

  return unsolvable(
    `exceeded ${MAX_ITERATIONS} co-bump iterations`,
    parseEresolve(result.stderr || result.stdout),
    result,
    attempted,
  );
}

function unsolvable(
  reason: string,
  conflict: ReturnType<typeof parseEresolve> | null,
  result: NpmRunResult,
  attempted: string[],
): ResolveOutcome {
  const raw = (result.stderr || result.stdout)
    .split("\n")
    .filter((l) => !/A complete log of this run|For a full report|_logs\//.test(l))
    .join("\n")
    .trim();
  return { status: "unsolvable", reason, conflict, rawError: raw, attempted };
}
