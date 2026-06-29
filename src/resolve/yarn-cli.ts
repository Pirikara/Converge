import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface YarnRunResult {
  ok: boolean;
  /** True when the project is Yarn Classic (v1), which we don't support. */
  classic?: boolean;
  warnings: string[];
  stderr: string;
}

/** Yarn Berry uses `packageManager: yarn@>=2`; classic is v1 (or unpinned). */
export async function isYarnBerry(workdir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const m = /^yarn@(\d+)/.exec(pkg.packageManager ?? "");
    return m != null && Number(m[1]) >= 2;
  } catch {
    return false;
  }
}

/** Parse Yarn Berry peer-dependency warnings (YN0002 "doesn't provide"). */
export function parseYarnPeerWarnings(output: string): string[] {
  const warnings: string[] = [];
  for (const line of output.split("\n")) {
    const m = /YN0002:.*?│\s*(.+doesn't provide.+)$/.exec(line);
    if (m) warnings.push(m[1]!.trim());
  }
  return warnings;
}

/**
 * Regenerate yarn.lock with Yarn Berry's `--mode=update-lockfile` (resolution
 * only — the link step is skipped, so nothing is fetched, built, or executed).
 * Run via corepack to honour the project's pinned Yarn version.
 */
export async function regenerateYarnLockfile(workdir: string): Promise<YarnRunResult> {
  if (!(await isYarnBerry(workdir))) {
    return { ok: false, classic: true, warnings: [], stderr: "Yarn Classic (v1) is not supported; only Yarn Berry (>=2)" };
  }
  const args = ["yarn", "install", "--mode=update-lockfile"];
  log.debug(`corepack ${args.join(" ")} (cwd=${workdir})`);
  try {
    const { stdout, stderr } = await execFileAsync("corepack", args, {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    return { ok: true, warnings: parseYarnPeerWarnings(stdout + stderr), stderr };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    const out = (e.stderr ?? "") + (e.stdout ?? "");
    return { ok: false, warnings: parseYarnPeerWarnings(out), stderr: out || String(err) };
  }
}
