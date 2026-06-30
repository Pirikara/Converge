/**
 * Ecosystem adapter contract (SPEC §4.4).
 * M0 implements the inventory slice: parseManifests + listOutdated + metadata.
 * Resolution / install / test arrive in M1.
 */

export type EcosystemId =
  | "npm"
  | "pip"
  | "gomod"
  | "cargo"
  | "rubygems"
  | "docker"
  | "github-actions";

export type DependencyKind =
  | "prod"
  | "dev"
  | "peer"
  | "optional";

export interface DependencyEntry {
  name: string;
  /** Declared version range as written in the manifest (e.g. "^1.2.0"). */
  range: string;
  kind: DependencyKind;
}

export interface Manifest {
  ecosystem: EcosystemId;
  /** Absolute path to the manifest file (e.g. package.json). */
  path: string;
  /** Directory containing the manifest, relative to repo root. */
  dir: string;
  dependencies: DependencyEntry[];
}

export interface UpdateCandidate {
  ecosystem: EcosystemId;
  manifestPath: string;
  dir: string;
  name: string;
  kind: DependencyKind;
  /** Current range from the manifest. */
  currentRange: string;
  /** Highest version currently satisfying the range, if resolvable. */
  currentVersion: string | null;
  /** Latest published version (per registry dist-tag `latest`). */
  latestVersion: string;
  /** semver delta of currentVersion -> latestVersion. */
  updateType: "major" | "minor" | "patch" | "none" | "unknown";
}

export interface PackageMeta {
  name: string;
  latest: string;
  /** All published versions, ascending by publish time when available. */
  versions: string[];
  /** ISO timestamp per version, when the registry exposes it. */
  publishedAt: Record<string, string>;
  /** Deprecation message of the latest version, if any. */
  deprecated: string | null;
  /** Deprecation message keyed by version (only deprecated versions present). */
  deprecations: Record<string, string>;
  /** Whether each version was published with npm provenance attestation. */
  provenance: Record<string, boolean>;
  /** Source repository URL from the latest manifest, if declared. */
  repositoryUrl: string | null;
}

export interface EcosystemAdapter {
  id: EcosystemId;
  /** Glob/filename markers that identify this ecosystem's manifests. */
  manifestFilenames: string[];
  /**
   * Optional path matcher for manifests that aren't identified by basename
   * alone (e.g. GitHub Actions workflows under `.github/workflows/*.yml`).
   * When present, discovery filters the repo tree by this predicate instead
   * of matching `manifestFilenames`.
   */
  manifestMatch?(repoRelPath: string): boolean;

  parseManifest(absPath: string, repoRoot: string): Promise<Manifest>;
  /** Parse a manifest from its raw text (for remote/in-memory files). */
  parseManifestContent(raw: string, absPath: string, repoRoot: string): Manifest;
  listOutdated(manifest: Manifest): Promise<UpdateCandidate[]>;
  fetchPackageMeta(name: string): Promise<PackageMeta>;
}
