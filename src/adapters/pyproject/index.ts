import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parsePyproject } from "./parse.js";
import { fetchPyPiMeta } from "../pip/pypi.js";
import { getVersioning } from "../../versioning/index.js";
import { log } from "../../logger.js";

const pep440 = getVersioning("pep440");

/** PEP 621 / Poetry pyproject.toml — same PyPI ecosystem as pip. */
export class PyProjectAdapter implements EcosystemAdapter {
  readonly id = "pip" as const;
  readonly manifestFilenames = ["pyproject.toml"];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "pip",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parsePyproject(raw),
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchPyPiMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        // First slice: exact == pins only (ranges/^ need lock modelling).
        const pin = "pin" in dep ? (dep as { pin: string | null }).pin : null;
        if (!pin) return null;
        const meta = await fetchPyPiMeta(dep.name);
        if (!meta.latest || !pep440.isGreaterThan(meta.latest, pin)) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "pip",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: pin,
          latestVersion: meta.latest,
          updateType: pep440.diff(pin, meta.latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`pyproject meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
