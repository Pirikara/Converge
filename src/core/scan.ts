import path from "node:path";
import { NpmAdapter } from "../adapters/npm/index.js";
import { PipAdapter } from "../adapters/pip/index.js";
import { GoAdapter } from "../adapters/gomod/index.js";
import { RubyGemsAdapter } from "../adapters/rubygems/index.js";
import { CargoAdapter } from "../adapters/cargo/index.js";
import { PyProjectAdapter } from "../adapters/pyproject/index.js";
import { DockerAdapter } from "../adapters/docker/index.js";
import type { EcosystemAdapter, Manifest, UpdateCandidate } from "../adapters/types.js";
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
 * Scan a repository for outdated dependencies across enabled ecosystems
 * (npm + pip). Resolution, safety, and impact stages attach in `run`.
 */
export async function scan(repoRootInput: string): Promise<ScanResult> {
  const repoRoot = path.resolve(repoRootInput);
  const { config, source } = await loadConfig(repoRoot);

  const enabled: { adapter: EcosystemAdapter; dirs: string[] }[] = [];
  if (config.ecosystems.npm.enabled) {
    enabled.push({ adapter: new NpmAdapter(), dirs: config.ecosystems.npm.directories });
  }
  if (config.ecosystems.pip.enabled) {
    enabled.push({ adapter: new PipAdapter(), dirs: config.ecosystems.pip.directories });
    enabled.push({ adapter: new PyProjectAdapter(), dirs: config.ecosystems.pip.directories });
  }
  if (config.ecosystems.gomod.enabled) {
    enabled.push({ adapter: new GoAdapter(), dirs: config.ecosystems.gomod.directories });
  }
  if (config.ecosystems.rubygems.enabled) {
    enabled.push({ adapter: new RubyGemsAdapter(), dirs: config.ecosystems.rubygems.directories });
  }
  if (config.ecosystems.cargo.enabled) {
    enabled.push({ adapter: new CargoAdapter(), dirs: config.ecosystems.cargo.directories });
  }
  if (config.ecosystems.docker.enabled) {
    enabled.push({ adapter: new DockerAdapter(), dirs: config.ecosystems.docker.directories });
  }

  const manifests: Manifest[] = [];
  const candidates: UpdateCandidate[] = [];

  for (const { adapter, dirs } of enabled) {
    const filename = adapter.manifestFilenames[0]!;
    const paths = await resolveManifestPaths(repoRoot, filename, dirs);
    log.debug(`${adapter.id}: ${paths.length} manifest(s) to scan`);

    for (const p of paths) {
      let manifest: Manifest;
      try {
        manifest = await adapter.parseManifest(p, repoRoot);
      } catch (err) {
        log.warn(`failed to parse ${p}: ${(err as Error).message}`);
        continue;
      }
      manifests.push(manifest);
      candidates.push(...(await adapter.listOutdated(manifest)));
    }
  }

  return { repoRoot, configSource: source, manifests, candidates };
}
