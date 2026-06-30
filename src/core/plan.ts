import path from "node:path";
import { NpmAdapter } from "../adapters/npm/index.js";
import { PipAdapter } from "../adapters/pip/index.js";
import { GoAdapter } from "../adapters/gomod/index.js";
import { RubyGemsAdapter } from "../adapters/rubygems/index.js";
import { CargoAdapter } from "../adapters/cargo/index.js";
import { PyProjectAdapter } from "../adapters/pyproject/index.js";
import { DockerAdapter } from "../adapters/docker/index.js";
import { GitHubActionsAdapter } from "../adapters/github-actions/index.js";
import { TerraformAdapter } from "../adapters/terraform/index.js";
import type { EcosystemAdapter, UpdateCandidate } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { log } from "../logger.js";

export type UpdateType = UpdateCandidate["updateType"];

export interface SelectOptions {
  /** Which semver bump types to propose. */
  allow: UpdateType[];
  /** Max number of candidates to select in one run. */
  limit: number;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Deterministic, idempotent branch name encoding the ecosystem + target version. */
export function branchName(c: UpdateCandidate): string {
  const scope = c.dir === "." ? "" : `${sanitize(c.dir)}-`;
  return `converge/${c.ecosystem}/${scope}${sanitize(c.name)}-${sanitize(c.latestVersion)}`;
}

/**
 * Discover outdated dependencies for a remote repo and select the candidates to
 * act on (filtered by bump type and capped by limit). Resolution happens later,
 * per candidate, in the apply step.
 */
export async function selectCandidates(
  gh: GitHubClient,
  ref: RepoRef,
  config: Config,
  opts: SelectOptions,
): Promise<{ base: string; selected: UpdateCandidate[] }> {
  const base = await gh.getDefaultBranch(ref);

  const ecosystems: { adapter: EcosystemAdapter; dirs: string[] }[] = [];
  if (config.ecosystems.npm.enabled) {
    ecosystems.push({ adapter: new NpmAdapter(), dirs: config.ecosystems.npm.directories });
  }
  if (config.ecosystems.pip.enabled) {
    ecosystems.push({ adapter: new PipAdapter(), dirs: config.ecosystems.pip.directories });
    ecosystems.push({ adapter: new PyProjectAdapter(), dirs: config.ecosystems.pip.directories });
  }
  if (config.ecosystems.gomod.enabled) {
    ecosystems.push({ adapter: new GoAdapter(), dirs: config.ecosystems.gomod.directories });
  }
  if (config.ecosystems.rubygems.enabled) {
    ecosystems.push({ adapter: new RubyGemsAdapter(), dirs: config.ecosystems.rubygems.directories });
  }
  if (config.ecosystems.cargo.enabled) {
    ecosystems.push({ adapter: new CargoAdapter(), dirs: config.ecosystems.cargo.directories });
  }
  if (config.ecosystems.docker.enabled) {
    ecosystems.push({ adapter: new DockerAdapter(), dirs: config.ecosystems.docker.directories });
  }
  if (config.ecosystems["github-actions"].enabled) {
    ecosystems.push({
      adapter: new GitHubActionsAdapter(),
      dirs: config.ecosystems["github-actions"].directories,
    });
  }
  if (config.ecosystems.terraform.enabled) {
    ecosystems.push({ adapter: new TerraformAdapter(), dirs: config.ecosystems.terraform.directories });
  }

  const selected: UpdateCandidate[] = [];
  for (const { adapter, dirs } of ecosystems) {
    const manifestPaths = adapter.manifestMatch
      ? await gh.findManifestPathsMatching(ref, base, adapter.manifestMatch.bind(adapter))
      : (
          await Promise.all(
            adapter.manifestFilenames.map((filename) =>
              dirs.length > 0
                ? Promise.resolve(dirs.map((d) => path.posix.join(d, filename)))
                : gh.findManifestPaths(ref, base, filename),
            ),
          )
        ).flat();
    log.debug(`${adapter.id}: scanning ${manifestPaths.length} manifest(s) on ${base}`);

    for (const mPath of manifestPaths) {
      const file = await gh.getFile(ref, mPath, base);
      if (!file) continue;
      const manifest = adapter.parseManifestContent(file.content, mPath, "");
      const candidates = await adapter.listOutdated(manifest);
      for (const c of candidates) {
        if (!opts.allow.includes(c.updateType)) continue;
        selected.push(c);
        if (selected.length >= opts.limit) return { base, selected };
      }
    }
  }
  return { base, selected };
}
