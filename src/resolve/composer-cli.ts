import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface ComposerResolveResult {
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
 * Regenerate composer.lock for a targeted dependency after its constraint in
 * composer.json has been edited: `composer update <pkg> --with-dependencies`.
 *
 * Resolves from composer.json + composer.lock + Packagist — no PHP source is
 * needed. `--no-install` writes only the lock (no vendor download); `--no-scripts
 * --no-plugins --no-autoloader` mean no third-party code runs.
 * `--ignore-platform-reqs` avoids failing on runner-missing PHP extensions.
 */
const COMPOSER_FLAGS = [
  "--no-install",
  "--no-scripts",
  "--no-autoloader",
  "--no-plugins",
  "--no-interaction",
  "--no-ansi",
  "--ignore-platform-reqs",
];

async function runComposer(workdir: string, args: string[]): Promise<ComposerResolveResult> {
  log.debug(`composer ${args.join(" ")} (cwd=${workdir})`);
  try {
    await execFileAsync("composer", args, {
      cwd: workdir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, COMPOSER_NO_INTERACTION: "1" },
    });
    const files: ResolvedFile[] = [];
    const cj = await readIfExists(workdir, "composer.json");
    if (cj) files.push(cj);
    const cl = await readIfExists(workdir, "composer.lock");
    if (cl) files.push(cl);
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}

export function resolveComposerLock(workdir: string, name: string): Promise<ComposerResolveResult> {
  return runComposer(workdir, ["update", name, "--with-dependencies", ...COMPOSER_FLAGS]);
}

/** Lockfile refresh: `composer update` (all deps) within composer.json ranges. */
export function updateComposerAll(workdir: string): Promise<ComposerResolveResult> {
  return runComposer(workdir, ["update", ...COMPOSER_FLAGS]);
}
