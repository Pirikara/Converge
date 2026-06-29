import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface CargoRunResult {
  ok: boolean;
  stderr: string;
}

/**
 * Lock a crate to `version` with `cargo update -p <name> --precise <version>`.
 * This updates Cargo.lock from the crates.io index WITHOUT compiling anything
 * (no build scripts, no proc-macros run) — code-exec-free resolution.
 */
export async function runCargoUpdate(
  workdir: string,
  name: string,
  version: string,
): Promise<CargoRunResult> {
  const args = ["update", "-p", name, "--precise", version];
  log.debug(`cargo ${args.join(" ")} (cwd=${workdir})`);
  try {
    await execFileAsync("cargo", args, { cwd: workdir, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}
