import { execFile } from "node:child_process";
import { readFile, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

const GO_ENV = { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" } as const;

/** Extract a gzip'd repo tarball into `destDir`, dropping the top-level folder. */
export async function extractTarballTo(tgz: Buffer, destDir: string): Promise<void> {
  const tgzPath = path.join(destDir, ".src.tgz");
  await writeFile(tgzPath, tgz);
  // GitHub tarballs nest everything under `{owner}-{repo}-{sha}/` — strip it.
  await execFileAsync("tar", ["-xzf", tgzPath, "-C", destDir, "--strip-components=1"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Renovate-style resolution: `go get module@version` then `go mod tidy`, run in
 * a directory that has the full module source, so go.sum is left in canonical
 * (tidy) form. `tidy -e` keeps going despite non-fatal issues. Reads back the
 * updated go.mod + go.sum. No package code is executed (module downloads only).
 */
export async function goGetAndTidy(
  moduleDir: string,
  modulePath: string,
  version: string,
): Promise<GoResolveResult> {
  const env = { ...process.env, ...GO_ENV };
  try {
    await execFileAsync("go", ["get", `${modulePath}@${version}`], { cwd: moduleDir, maxBuffer: 32 * 1024 * 1024, env });
    await execFileAsync("go", ["mod", "tidy", "-e"], { cwd: moduleDir, maxBuffer: 64 * 1024 * 1024, env });
    const files: ResolvedFile[] = [];
    const gomod = await readIfExists(moduleDir, "go.mod");
    if (gomod) files.push(gomod);
    const gosum = await readIfExists(moduleDir, "go.sum");
    if (gosum) files.push(gosum);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}

export interface GoResolveResult {
  ok: boolean;
  files: ResolvedFile[];
  stderr: string;
}

/**
 * `go get m@new` records the new version's hashes but does not remove the old
 * version's *zip* hash (that pruning is `go mod tidy`'s job, which needs the
 * source tree). Once `new` is selected, `old`'s zip is never used, so its
 * `m old h1:…` line is dead weight. Drop only that line — the `m old/go.mod`
 * hash may still be required for module-graph (MVS) computation, so it stays.
 * Guarded: only prune when the new version's zip line is present.
 */
export function pruneStaleZipHash(gosum: string, module: string, oldVersion: string, newVersion: string): string {
  const newZip = `${module} ${newVersion} `;
  if (!gosum.split("\n").some((l) => l.startsWith(newZip))) return gosum;
  const oldZip = `${module} ${oldVersion} `; // trailing space ⇒ the zip line, not `…/go.mod`
  return gosum
    .split("\n")
    .filter((l) => !l.startsWith(oldZip))
    .join("\n");
}

async function readIfExists(dir: string, name: string): Promise<ResolvedFile | null> {
  try {
    await access(path.join(dir, name));
    return { name, content: await readFile(path.join(dir, name), "utf8") };
  } catch {
    return null;
  }
}

/**
 * Update a Go module requirement with `go get module@version`. In module mode
 * this updates go.mod + go.sum (downloading metadata/zips to the cache) WITHOUT
 * compiling or running any module code. GOTOOLCHAIN=local avoids network
 * toolchain switches.
 */
export async function resolveGoModule(
  workdir: string,
  modulePath: string,
  version: string,
  previousVersion?: string,
): Promise<GoResolveResult> {
  const args = ["get", `${modulePath}@${version}`];
  log.debug(`go ${args.join(" ")} (cwd=${workdir})`);
  try {
    await execFileAsync("go", args, {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" },
    });
    const files: ResolvedFile[] = [];
    const gomod = await readIfExists(workdir, "go.mod");
    if (gomod) files.push(gomod);
    const gosum = await readIfExists(workdir, "go.sum");
    if (gosum) {
      if (previousVersion && previousVersion !== version) {
        gosum.content = pruneStaleZipHash(gosum.content, modulePath, previousVersion, version);
      }
      files.push(gosum);
    }
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}
