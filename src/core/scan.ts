import path from "node:path";
import { NpmAdapter } from "../adapters/npm/index.js";
import type { Manifest, UpdateCandidate } from "../adapters/types.js";
import { resolveManifestPaths } from "./discover.js";
import { loadConfig } from "../config/load.js";
import { log } from "../logger.js";

export interface ScanResult {
  repoRoot: string;
  configSource: string | null;
  manifests: Manifest[];
  candidates: UpdateCandidate[];
}

/**
 * M0 scan: load config, discover npm manifests, and list outdated dependencies.
 * (Resolution, safety, and impact stages attach in later milestones.)
 */
export async function scan(repoRootInput: string): Promise<ScanResult> {
  const repoRoot = path.resolve(repoRootInput);
  const { config, source } = await loadConfig(repoRoot);

  const manifests: Manifest[] = [];
  const candidates: UpdateCandidate[] = [];

  if (config.ecosystems.npm.enabled) {
    const adapter = new NpmAdapter();
    const paths = await resolveManifestPaths(
      repoRoot,
      "package.json",
      config.ecosystems.npm.directories,
    );
    log.debug(`npm: ${paths.length} manifest(s) to scan`);

    for (const p of paths) {
      let manifest: Manifest;
      try {
        manifest = await adapter.parseManifest(p, repoRoot);
      } catch (err) {
        log.warn(`failed to parse ${p}: ${(err as Error).message}`);
        continue;
      }
      manifests.push(manifest);
      const outdated = await adapter.listOutdated(manifest);
      candidates.push(...outdated);
    }
  }

  return { repoRoot, configSource: source, manifests, candidates };
}
