import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseDockerfile } from "./dockerfile.js";
import { parseCompose } from "./compose.js";
import { fetchDockerTags } from "./registry.js";

function isComposeFile(p: string): boolean {
  return /(^|\/)(docker-)?compose\.ya?ml$/.test(p);
}
import { pickNewerDockerTag, dockerUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** Docker base images (Dockerfile `FROM`), tags resolved via Docker Hub. */
export class DockerAdapter implements EcosystemAdapter {
  readonly id = "docker" as const;
  readonly manifestFilenames = [
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "docker",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: isComposeFile(absPath) ? parseCompose(raw) : parseDockerfile(raw),
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    const versions = await fetchDockerTags(name);
    return {
      name,
      latest: "",
      versions,
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
        const tags = await fetchDockerTags(dep.name);
        if (tags.length === 0) return null; // non-Hub registry or unknown image
        const newer = pickNewerDockerTag(dep.range, tags);
        if (!newer) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "docker",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: dep.range,
          latestVersion: newer,
          updateType: dockerUpdateType(dep.range, newer),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`dockerhub failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
