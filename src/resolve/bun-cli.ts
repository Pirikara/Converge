import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface BunRunResult {
  ok: boolean;
  warnings: string[];
  stderr: string;
}

/** Best-effort parse of bun peer-dependency warnings. */
export function parseBunPeerWarnings(output: string): string[] {
  const warnings: string[] = [];
  for (const line of output.split("\n")) {
    if (/peer/i.test(line) && /(unmet|incorrect|not|missing)/i.test(line)) {
      warnings.push(line.replace(/^\s*(warn|warning)\s*[:!]?\s*/i, "").trim());
    }
  }
  return warnings;
}

/**
 * Regenerate bun.lock without installing or running any package code
 * (`--lockfile-only --ignore-scripts`). bun writes a text lockfile by default.
 */
export async function regenerateBunLockfile(workdir: string): Promise<BunRunResult> {
  const args = ["install", "--lockfile-only", "--ignore-scripts", "--no-summary", "--no-progress"];
  log.debug(`bun ${args.join(" ")} (cwd=${workdir})`);
  try {
    const { stdout, stderr } = await execFileAsync("bun", args, {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, warnings: parseBunPeerWarnings(stdout + stderr), stderr };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    const out = (e.stderr ?? "") + (e.stdout ?? "");
    return { ok: false, warnings: parseBunPeerWarnings(out), stderr: out || String(err) };
  }
}
