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
    if (gosum) files.push(gosum);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}
