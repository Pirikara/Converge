import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  DependencyEntry,
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { fetchPackageMeta } from "./registry.js";
import { getVersioning } from "../../versioning/index.js";
import { log } from "../../logger.js";

const ver = getVersioning("semver");

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** A range we cannot meaningfully bump (protocols, tags, workspace links). */
function isResolvableRange(range: string): boolean {
  if (range === "" || range === "*" || range === "latest") return false;
  // npm/git/file/workspace protocols and URLs are out of scope for M0.
  if (/^(npm|git|github|file|link|workspace|https?):/i.test(range)) return false;
  if (range.includes("/")) return false; // e.g. user/repo shorthand
  return semver.validRange(range) != null;
}

function classifyUpdate(from: string | null, to: string): UpdateCandidate["updateType"] {
  if (!from) return "unknown";
  return ver.diff(from, to);
}

/**
 * "in-range" candidate: never leave the declared range's major. Targets the
 * highest published version that still satisfies the range and, when that sits
 * above the range's floor, bumps the floor to it (e.g. "^3.23.8" → "^3.25.76").
 * An exact pin or an already-current floor yields no update.
 */
function inRangeCandidate(
  manifest: Manifest,
  dep: DependencyEntry,
  versions: string[],
): UpdateCandidate | null {
  const floor = semver.minVersion(dep.range)?.version;
  const inRangeMax = ver.maxSatisfying(versions, dep.range);
  if (!floor || !inRangeMax || ver.compare(inRangeMax, floor) <= 0) return null;
  return {
    ecosystem: "npm",
    manifestPath: manifest.path,
    dir: manifest.dir,
    name: dep.name,
    kind: dep.kind,
    currentRange: dep.range,
    currentVersion: floor,
    latestVersion: inRangeMax,
    updateType: classifyUpdate(floor, inRangeMax),
  };
}

export type UpdateStrategy = "latest" | "in-range";

export class NpmAdapter implements EcosystemAdapter {
  readonly id = "npm" as const;
  readonly manifestFilenames = ["package.json"];

  /** "latest" (default) targets the dist-tag latest; "in-range" stays within
   * the declared range's major (bumps the range floor to the highest in-range
   * version). */
  constructor(private readonly strategy: UpdateStrategy = "latest") {}

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    const raw = await readFile(absPath, "utf8");
    return this.parseManifestContent(raw, absPath, repoRoot);
  }

  /** Parse a manifest from its raw text (used for remote/in-memory files). */
  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    const pkg = JSON.parse(raw) as PackageJson;
    const deps: DependencyEntry[] = [];
    const add = (
      block: Record<string, string> | undefined,
      kind: DependencyEntry["kind"],
    ): void => {
      for (const [name, range] of Object.entries(block ?? {})) {
        deps.push({ name, range, kind });
      }
    };
    add(pkg.dependencies, "prod");
    add(pkg.devDependencies, "dev");
    add(pkg.peerDependencies, "peer");
    add(pkg.optionalDependencies, "optional");

    return {
      ecosystem: "npm",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: deps,
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchPackageMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        if (!isResolvableRange(dep.range)) {
          log.debug(`skip ${dep.name}@${dep.range} (unresolvable range)`);
          return null;
        }
        const meta = await fetchPackageMeta(dep.name);
        if (!meta.latest) return null;

        if (this.strategy === "in-range") {
          return inRangeCandidate(manifest, dep, meta.versions);
        }

        const currentVersion = ver.maxSatisfying(meta.versions, dep.range);

        // Outdated only when latest is strictly newer than what the range allows.
        if (currentVersion && ver.compare(currentVersion, meta.latest) >= 0) {
          return null;
        }
        if (!currentVersion && !ver.isValid(meta.latest)) {
          return null;
        }

        const candidate: UpdateCandidate = {
          ecosystem: "npm",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion,
          latestVersion: meta.latest,
          updateType: classifyUpdate(currentVersion, meta.latest),
        };
        return candidate;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
