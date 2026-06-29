import { mkdtemp, copyFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const COPY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
];

/**
 * Create an isolated working copy containing just the files npm needs to
 * resolve a lockfile. We never copy node_modules and never run package code.
 */
export async function prepareWorkdir(srcDir: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "converge-resolve-"));
  for (const name of COPY_FILES) {
    const src = path.join(srcDir, name);
    try {
      await access(src);
    } catch {
      continue;
    }
    await copyFile(src, path.join(dir, name));
  }
  return dir;
}

export async function cleanupWorkdir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
