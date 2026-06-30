import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseComposerJson } from "./manifest.js";
import { fetchComposerVersions } from "./packagist.js";
import { currentSatisfied, latestStable, bumpConstraint, composerUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** A composer.json outside the vendor/ install tree. */
export function isComposerManifest(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, "/");
  if (norm.split("/").includes("vendor")) return false;
  return (norm.split("/").pop() ?? "") === "composer.json";
}

/** Composer (PHP) `require` / `require-dev`, resolved via Packagist. */
export class ComposerAdapter implements EcosystemAdapter {
  readonly id = "composer" as const;
  readonly manifestFilenames = ["composer.json"];

  manifestMatch(repoRelPath: string): boolean {
    return isComposerManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "composer",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseComposerJson(raw),
    };
  }

  fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchComposerMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        const versions = await fetchComposerVersions(dep.name);
        if (versions.length === 0) return null;
        const latest = latestStable(versions);
        if (!latest) return null;

        const current = currentSatisfied(dep.range, versions);
        if (current && !semver.gt(latest, current)) return null; // constraint already covers latest

        const newConstraint = bumpConstraint(dep.range, latest);
        if (!newConstraint || newConstraint === dep.range) return null; // can't rewrite / no change

        const candidate: UpdateCandidate = {
          ecosystem: "composer",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: current,
          latestVersion: latest, // concrete (OSV safety + display)
          writeRange: newConstraint, // constraint actually written to the file
          updateType: current ? composerUpdateType(current, latest) : "unknown",
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`packagist failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}

/** Versions-only metadata for a Composer package. */
export async function fetchComposerMeta(name: string): Promise<PackageMeta> {
  const versions = await fetchComposerVersions(name);
  return {
    name,
    latest: latestStable(versions) ?? "",
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: `https://packagist.org/packages/${name}`,
  };
}
