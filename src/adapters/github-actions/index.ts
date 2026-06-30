import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseWorkflow } from "./workflow.js";
import { fetchActionTags } from "./tags.js";
import { pickNewerActionTag, actionUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

/** Tags-only metadata for an `owner/repo` action (no publish dates exposed). */
export async function fetchActionMeta(name: string): Promise<PackageMeta> {
  const versions = await fetchActionTags(name);
  return {
    name,
    latest: "",
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: `https://github.com/${name}`,
  };
}

/** A workflow under `.github/workflows/` or a composite-action manifest. */
export function isActionsManifest(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, "/");
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(norm)) return true;
  const base = norm.split("/").pop() ?? "";
  return base === "action.yml" || base === "action.yaml";
}

/** GitHub Actions: `uses:` refs in workflows, resolved via GitHub git tags. */
export class GitHubActionsAdapter implements EcosystemAdapter {
  readonly id = "github-actions" as const;
  // Composite-action files are basename-matchable; workflows need manifestMatch.
  readonly manifestFilenames = ["action.yml", "action.yaml"];

  manifestMatch(repoRelPath: string): boolean {
    return isActionsManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "github-actions",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseWorkflow(raw),
    };
  }

  fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchActionMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        const tags = await fetchActionTags(dep.name);
        if (tags.length === 0) return null;
        const newer = pickNewerActionTag(dep.range, tags);
        if (!newer) return null;
        const candidate: UpdateCandidate = {
          ecosystem: "github-actions",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: dep.range,
          latestVersion: newer,
          updateType: actionUpdateType(dep.range, newer),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`github tags failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
