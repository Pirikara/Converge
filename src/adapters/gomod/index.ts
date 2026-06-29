import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseGoMod } from "./gomod.js";
import { fetchGoMeta } from "./proxy.js";
import { getVersioning } from "../../versioning/index.js";
import { log } from "../../logger.js";

const ver = getVersioning("go");

export class GoAdapter implements EcosystemAdapter {
  readonly id = "gomod" as const;
  readonly manifestFilenames = ["go.mod"];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "gomod",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseGoMod(raw),
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchGoMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        // Skip transitive (// indirect) requirements in the first slice.
        if ("indirect" in dep && (dep as { indirect: boolean }).indirect) return null;
        const meta = await fetchGoMeta(dep.name);
        if (!meta.latest || !ver.isGreaterThan(meta.latest, dep.range)) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "gomod",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: dep.range, // go.mod pins exact versions
          latestVersion: meta.latest,
          updateType: ver.diff(dep.range, meta.latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`goproxy meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
