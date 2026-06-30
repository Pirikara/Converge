import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseChart } from "./chart.js";
import { fetchHelmVersions } from "./index-yaml.js";
import { currentSatisfied, latestStable, bumpConstraint, helmUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** A top-level Chart.yaml (not a bundled subchart under a `charts/` dir). */
export function isHelmManifest(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, "/");
  if (norm.includes("/charts/")) return false; // bundled dependency chart
  return (norm.split("/").pop() ?? "") === "Chart.yaml";
}

/** Helm chart dependencies, resolved via the repository's index.yaml. */
export class HelmAdapter implements EcosystemAdapter {
  readonly id = "helm" as const;
  readonly manifestFilenames = ["Chart.yaml"];

  manifestMatch(repoRelPath: string): boolean {
    return isHelmManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "helm",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseChart(raw),
    };
  }

  // Charts are repository-scoped; there's no name-only metadata endpoint.
  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return {
      name,
      latest: "",
      versions: [],
      publishedAt: {},
      deprecated: null,
      deprecations: {},
      provenance: {},
      repositoryUrl: null,
    };
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        if (!dep.repository) return null;
        const versions = await fetchHelmVersions(dep.repository, dep.name);
        if (versions.length === 0) return null;
        const latest = latestStable(versions);
        if (!latest) return null;

        const current = currentSatisfied(dep.range, versions);
        if (current && !semver.gt(latest, current)) return null; // constraint covers latest

        const newConstraint = bumpConstraint(dep.range, latest);
        if (!newConstraint || newConstraint === dep.range) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "helm",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: current,
          latestVersion: newConstraint,
          updateType: current ? helmUpdateType(current, latest) : "unknown",
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`helm failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
