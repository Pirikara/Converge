import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface NpmRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Regenerate package-lock.json by resolving the dependency tree WITHOUT
 * downloading or executing any package code.
 *
 *   --package-lock-only : resolve + write lockfile, no node_modules
 *   --ignore-scripts    : never run lifecycle scripts (defense in depth)
 *
 * This is SafeBump's core resolution primitive: it surfaces ERESOLVE conflicts
 * exactly like a real install would, but with zero arbitrary code execution.
 */
export async function resolveLockfile(dir: string): Promise<NpmRunResult> {
  const args = [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  log.debug(`npm ${args.join(" ")} (cwd=${dir})`);
  try {
    const { stdout, stderr } = await execFileAsync("npm", args, {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", npm_config_audit: "false" },
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
    };
  }
}

export function isEresolve(result: NpmRunResult): boolean {
  return /ERESOLVE/.test(result.stderr) || /ERESOLVE/.test(result.stdout);
}
