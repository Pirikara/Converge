import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EcosystemAdapter,
  DependencyEntry,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parsePom, editPomVersion } from "./pom.js";
import { parseGradle, editGradleVersion } from "./gradle.js";
import { parseVersionCatalog, editVersionCatalog } from "./catalog.js";
import { fetchMavenVersions } from "./central.js";
import { compareMaven, maxStableMaven, maxStableMavenFor, mavenUpdateType } from "./versioning.js";
import { log } from "../../logger.js";

const BUILD_DIRS = new Set(["build", "target", ".gradle"]);

/** A Maven/Gradle manifest outside build output directories. */
export function isMavenManifest(repoRelPath: string): boolean {
  const norm = repoRelPath.replace(/\\/g, "/");
  const segments = norm.split("/");
  if (segments.slice(0, -1).some((s) => BUILD_DIRS.has(s))) return false;
  const base = segments[segments.length - 1] ?? "";
  return base === "pom.xml" || base === "libs.versions.toml" || /\.gradle(\.kts)?$/.test(base);
}

function parseFor(file: string, raw: string): DependencyEntry[] {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base === "pom.xml") return parsePom(raw);
  if (base === "libs.versions.toml") return parseVersionCatalog(raw);
  return parseGradle(raw);
}

/** Apply a version edit to the correct manifest format. */
export function editMavenManifest(
  file: string,
  content: string,
  name: string,
  from: string,
  to: string,
): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base === "pom.xml") return editPomVersion(content, name, from, to);
  if (base === "libs.versions.toml") return editVersionCatalog(content, name, from, to);
  return editGradleVersion(content, name, from, to);
}

/** Maven & Gradle dependencies, resolved via Maven Central maven-metadata.xml. */
export class MavenAdapter implements EcosystemAdapter {
  readonly id = "maven" as const;
  readonly manifestFilenames = ["pom.xml", "build.gradle", "build.gradle.kts", "libs.versions.toml"];

  manifestMatch(repoRelPath: string): boolean {
    return isMavenManifest(repoRelPath);
  }

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    return this.parseManifestContent(await readFile(absPath, "utf8"), absPath, repoRoot);
  }

  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest {
    return {
      ecosystem: "maven",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: parseFor(absPath, raw),
    };
  }

  fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchMavenMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        const versions = await fetchMavenVersions(dep.name);
        if (versions.length === 0) return null;
        const latest = maxStableMavenFor(dep.range, versions);
        if (!latest || compareMaven(latest, dep.range) <= 0) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "maven",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: dep.range,
          latestVersion: latest,
          updateType: mavenUpdateType(dep.range, latest),
        };
        return candidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`maven central failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}

/** Versions-only metadata for a `group:artifact`. */
export async function fetchMavenMeta(name: string): Promise<PackageMeta> {
  const versions = await fetchMavenVersions(name);
  return {
    name,
    latest: maxStableMaven(versions) ?? "",
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: `https://central.sonatype.com/artifact/${name.replace(":", "/")}`,
  };
}
