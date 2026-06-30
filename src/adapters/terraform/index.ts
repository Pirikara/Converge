import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseTerraform } from "./hcl.js";
import { fetchTerraformVersions } from "./registry.js";
import { currentSatisfied, latestStable, bumpConstraint, tfUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** A `.tf` file outside the local `.terraform/` cache. */
export function isTerraformManifest(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, "/");
  if (norm.split("/").includes(".terraform")) return false;
  return norm.endsWith(".tf");
}

/** Terraform providers + registry modules, resolved via the Terraform Registry. */
export class TerraformAdapter implements EcosystemAdapter {
  readonly id = "terraform" as const;
  readonly manifestFilenames = []; // matched by path, not basename

  manifestMatch(repoRelPath: string): boolean {
    return isTerraformManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "terraform",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseTerraform(raw),
    };
  }

  fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchTerraformMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        const versions = await fetchTerraformVersions(dep.name);
        if (versions.length === 0) return null;
        const latest = latestStable(versions);
        if (!latest) return null;

        const current = currentSatisfied(dep.range, versions);
        if (current && !semver.gt(latest, current)) return null; // constraint already covers latest

        const newConstraint = bumpConstraint(dep.range, latest);
        if (!newConstraint || newConstraint === dep.range) return null; // can't rewrite / no change

        const candidate: UpdateCandidate = {
          ecosystem: "terraform",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: current,
          latestVersion: newConstraint,
          updateType: current ? tfUpdateType(current, latest) : "unknown",
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`terraform registry failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}

/** Versions-only metadata for a Terraform registry dependency. */
export async function fetchTerraformMeta(name: string): Promise<PackageMeta> {
  const versions = await fetchTerraformVersions(name);
  return {
    name,
    latest: latestStable(versions) ?? "",
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: `https://registry.terraform.io/${name.split("/").length === 2 ? "providers" : "modules"}/${name}`,
  };
}
