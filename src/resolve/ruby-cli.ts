import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface RubyResolveResult {
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
 * Regenerate Gemfile.lock with `bundle lock` (resolution only — gems are not
 * installed, so no native extensions are built and no gem code runs). Note:
 * bundler does evaluate the repo's own Gemfile (Ruby), but never third-party
 * gem code.
 */
export async function resolveBundleLock(workdir: string): Promise<RubyResolveResult> {
  log.debug(`bundle lock (cwd=${workdir})`);
  try {
    await execFileAsync("bundle", ["lock"], {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, BUNDLE_FROZEN: "false", BUNDLE_GEMFILE: path.join(workdir, "Gemfile") },
    });
    const files: ResolvedFile[] = [];
    const gemfile = await readIfExists(workdir, "Gemfile");
    if (gemfile) files.push(gemfile);
    const lock = await readIfExists(workdir, "Gemfile.lock");
    if (lock) files.push(lock);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}

/**
 * Lock file refresh: `bundle lock --update` re-resolves every gem to the latest
 * version allowed by the Gemfile (the Gemfile itself is never modified), writing
 * only Gemfile.lock — no gems installed, no third-party gem code run.
 */
export async function updateBundleAll(workdir: string): Promise<RubyResolveResult> {
  log.debug(`bundle lock --update (cwd=${workdir})`);
  try {
    await execFileAsync("bundle", ["lock", "--update"], {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, BUNDLE_FROZEN: "false", BUNDLE_GEMFILE: path.join(workdir, "Gemfile") },
    });
    const files: ResolvedFile[] = [];
    const lock = await readIfExists(workdir, "Gemfile.lock");
    if (lock) files.push(lock);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}
