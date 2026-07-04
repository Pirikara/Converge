import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseCargoToml } from "./cargo-toml.js";
import { fetchCrateMeta } from "./cratesio.js";
import { cargoUpdateType } from "./versioning.js";
import { getVersioning } from "../../versioning/index.js";
import { log } from "../../logger.js";

const ver = getVersioning("semver");

/** Cargo defaults a bare version requirement to caret (`1.0` === `^1.0`). */
function normalizeCargoRange(range: string): string {
  return /^\d/.test(range.trim()) ? `^${range.trim()}` : range.trim();
}

export class CargoAdapter implements EcosystemAdapter {
  readonly id = "cargo" as const;
  readonly manifestFilenames = ["Cargo.toml"];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "cargo",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseCargoToml(raw),
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchCrateMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        const meta = await fetchCrateMeta(dep.name);
        if (!meta.latest) return null;
        const range = normalizeCargoRange(dep.range);
        const currentVersion = ver.maxSatisfying(meta.versions, range);
        if (currentVersion && ver.compare(currentVersion, meta.latest) >= 0) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "cargo",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion,
          latestVersion: meta.latest,
          updateType: cargoUpdateType(currentVersion ?? dep.range, meta.latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`crates.io meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
