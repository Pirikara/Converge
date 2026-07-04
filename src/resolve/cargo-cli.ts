import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface CargoRunResult {
  ok: boolean;
  stderr: string;
}

export interface CargoUpdateResult {
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
 * Lock file refresh: `cargo update` (all crates) advances Cargo.lock to the
 * latest versions allowed by Cargo.toml — Cargo.toml is never modified, so no
 * specifier drift. Resolves from the crates.io index; no crate code is compiled
 * or run.
 */
export async function updateCargoAll(workdir: string): Promise<CargoUpdateResult> {
  // MSRV-aware: when the crate declares `rust-version`, don't pull versions that
  // require a newer rustc than the project supports (falls back to a compatible
  // version). Harmless when no rust-version is declared.
  const args = ["update", "--config", 'resolver.incompatible-rust-versions="fallback"'];
  log.debug(`cargo ${args.join(" ")} (cwd=${workdir})`);
  try {
    await execFileAsync("cargo", args, { cwd: workdir, maxBuffer: 32 * 1024 * 1024 });
    const files: ResolvedFile[] = [];
    const lock = await readIfExists(workdir, "Cargo.lock");
    if (lock) files.push(lock);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
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
