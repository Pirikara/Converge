import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseCsproj } from "./csproj.js";
import { fetchNuGetVersions } from "./registry.js";
import { parseNuGetVersion, compareNuGet, maxStableNuGet, nugetUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** A .NET project file or a Central Package Management props file. */
export function isNuGetManifest(repoRelPath: string): boolean {
  const base = repoRelPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return /\.(cs|fs|vb)proj$/.test(base) || base === "Directory.Packages.props";
}

/** NuGet `PackageReference`s, resolved via the nuget.org flat-container index. */
export class NuGetAdapter implements EcosystemAdapter {
  readonly id = "nuget" as const;
  readonly manifestFilenames = []; // matched by path, not basename

  manifestMatch(repoRelPath: string): boolean {
    return isNuGetManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "nuget",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseCsproj(raw),
    };
  }

  fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchNuGetMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        // Only plain, single versions — bracket/floating ranges aren't bumped.
        if (!parseNuGetVersion(dep.range)) return null;
        const versions = await fetchNuGetVersions(dep.name);
        if (versions.length === 0) return null;
        const latest = maxStableNuGet(versions);
        if (!latest || compareNuGet(latest, dep.range) <= 0) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "nuget",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: dep.range,
          latestVersion: latest,
          updateType: nugetUpdateType(dep.range, latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`nuget failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}

/** Versions-only metadata for a NuGet package. */
export async function fetchNuGetMeta(name: string): Promise<PackageMeta> {
  const versions = await fetchNuGetVersions(name);
  return {
    name,
    latest: maxStableNuGet(versions) ?? "",
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: `https://www.nuget.org/packages/${name}`,
  };
}
