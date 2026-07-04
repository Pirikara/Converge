import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface PnpmRunResult {
  ok: boolean;
  /** Unmet peer-dependency warnings parsed from pnpm output. */
  warnings: string[];
  stderr: string;
}

/** Parse pnpm's "✕ unmet peer X: found Y" lines into plain warnings. */
export function parsePnpmPeerWarnings(output: string): string[] {
  const warnings: string[] = [];
  for (const line of output.split("\n")) {
    const m = /unmet peer\s+(.+?):\s*found\s+(.+)$/.exec(line);
    if (m) warnings.push(`unmet peer ${m[1]!.trim()}: found ${m[2]!.trim()}`);
  }
  return warnings;
}

async function pnpmCommand(workdir: string): Promise<string[]> {
  // Honour the repo's pinned pnpm via corepack (lockfile-format fidelity);
  // fall back to the system pnpm when there is no packageManager field.
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    if (pkg.packageManager?.startsWith("pnpm@")) return ["corepack", "pnpm"];
  } catch {
    /* ignore */
  }
  // No pin: still go through corepack (bundled with Node ≥16.9) rather than a
  // bare `pnpm`, which may be absent (e.g. on CI runners → spawn ENOENT).
  return ["corepack", "pnpm"];
}

/**
 * Regenerate pnpm-lock.yaml without downloading packages or running scripts
 * (`--lockfile-only --ignore-scripts`). pnpm treats peer conflicts as warnings
 * rather than errors, so we resolve and report the warnings.
 */
export async function regeneratePnpmLockfile(workdir: string): Promise<PnpmRunResult> {
  const [cmd, ...pre] = await pnpmCommand(workdir);
  const args = [...pre, "install", "--lockfile-only", "--ignore-scripts", "--no-color"];
  log.debug(`${cmd} ${args.join(" ")} (cwd=${workdir})`);
  try {
    const { stdout, stderr } = await execFileAsync(cmd!, args, {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    return { ok: true, warnings: parsePnpmPeerWarnings(stdout + stderr), stderr };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    const out = (e.stderr ?? "") + (e.stdout ?? "");
    return { ok: false, warnings: parsePnpmPeerWarnings(out), stderr: out || String(err) };
  }
}
