import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseGemfile } from "./gemfile.js";
import { fetchGemMeta } from "./rubygems.js";
import { getVersioning } from "../../versioning/index.js";
import { log } from "../../logger.js";

const ver = getVersioning("gem");

export class RubyGemsAdapter implements EcosystemAdapter {
  readonly id = "rubygems" as const;
  readonly manifestFilenames = ["Gemfile"];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "rubygems",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseGemfile(raw),
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchGemMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        // First slice: act on exact pins only (ranges need Gemfile.lock modelling).
        const pin = "pin" in dep ? (dep as { pin: string | null }).pin : null;
        if (!pin) {
          log.debug(`skip ${dep.name} (${dep.range || "no constraint"}; not an exact pin)`);
          return null;
        }
        const meta = await fetchGemMeta(dep.name);
        if (!meta.latest || !ver.isGreaterThan(meta.latest, pin)) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "rubygems",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: pin,
          latestVersion: meta.latest,
          updateType: ver.diff(pin, meta.latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`rubygems meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
