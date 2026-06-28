import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".venv",
]);

/**
 * Recursively find files named `filename` under `root`, skipping vendored and
 * build directories. Returns absolute paths.
 */
export async function findManifests(
  root: string,
  filename: string,
  maxDepth = 6,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name === filename) {
        found.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return found.sort();
}

/**
 * Resolve the set of manifest paths to scan: explicit config directories when
 * provided, otherwise auto-discovery.
 */
export async function resolveManifestPaths(
  repoRoot: string,
  filename: string,
  configuredDirs: string[],
): Promise<string[]> {
  if (configuredDirs.length === 0) {
    return findManifests(repoRoot, filename);
  }
  return configuredDirs.map((d) => path.join(repoRoot, d, filename));
}
