import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

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
