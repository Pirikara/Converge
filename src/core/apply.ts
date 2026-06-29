import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpRange } from "../adapters/npm/range.js";
import type { UpdateCandidate } from "../adapters/types.js";
import { GitHubClient, type RepoRef } from "../github/client.js";
import { resolvePipUpdate } from "../resolve/pip.js";
import { uvLock } from "../resolve/uv-cli.js";
import { editPyproject } from "../adapters/pyproject/parse.js";
import { resolveGoModule } from "../resolve/go-cli.js";
import { resolveBundleLock } from "../resolve/ruby-cli.js";
import { editGemfilePin } from "../adapters/rubygems/gemfile.js";
import { runCargoUpdate } from "../resolve/cargo-cli.js";
import { editCargoToml } from "../adapters/cargo/cargo-toml.js";
import { editDockerfileTag } from "../adapters/docker/dockerfile.js";
import { getResolver } from "../resolve/npm-family.js";
import type { NpmPackageManager } from "../resolve/pm-detect.js";
import { cleanupWorkdir } from "../resolve/workdir.js";
import type { PackageChange } from "../resolve/types.js";
import { log } from "../logger.js";

/** Normalised resolution result across ecosystems. */
export interface CandidateResolution {
  candidate: UpdateCandidate;
  status: "resolved" | "resolved-cobump" | "unsolvable" | "needs-build";
  changes: PackageChange[];
  /** Repo-relative files to commit (empty unless resolved). */
  repoFiles: { path: string; content: string }[];
  /** Number of automatic co-bumps applied. */
  cobumps: number;
  /** Non-fatal warnings (e.g. pnpm unmet peers). */
  warnings: string[];
  /** Explanation for unsolvable / needs-build. */
  reason?: string;
}

async function resolveNpmFamily(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
  pm: NpmPackageManager,
): Promise<CandidateResolution> {
  const resolver = getResolver(pm);
  if (!resolver) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: `no resolver for ${pm}` };
  }
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-apply-"));
  try {
    const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
    if (!pkg) throw new Error(`package.json not found in ${dir}`);
    await writeFile(path.join(workdir, "package.json"), pkg.content);
    for (const name of resolver.lockfileNames) {
      const lock = await gh.getFile(ref, `${prefix}${name}`, base);
      if (lock) {
        await writeFile(path.join(workdir, name), lock.content);
        break;
      }
    }

    const fromRange = candidate.currentRange;
    const toRange = bumpRange(fromRange, candidate.latestVersion);
    const r = await resolver.resolve({ workdir, name: candidate.name, fromRange, toRange });

    if (r.status === "unsolvable") {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: r.warnings, reason: r.reason };
    }
    return {
      candidate,
      status: r.status,
      changes: r.changes,
      repoFiles: r.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
      cobumps: r.changes.filter((c) => c.cobump).length,
      warnings: r.warnings,
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolvePip(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  if (!candidate.currentVersion) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: "no pinned version to bump" };
  }
  const file = path.posix.basename(candidate.manifestPath); // requirements.txt
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-pip-"));
  try {
    const src = await gh.getFile(ref, candidate.manifestPath, base);
    if (!src) throw new Error(`${candidate.manifestPath} not found`);
    await writeFile(path.join(workdir, file), src.content);

    const outcome = await resolvePipUpdate({
      workdir,
      requirementsFile: file,
      name: candidate.name,
      fromPin: candidate.currentVersion,
      toVersion: candidate.latestVersion,
    });

    if (outcome.status === "resolved") {
      const edited = await readFile(path.join(workdir, file), "utf8");
      return {
        candidate,
        status: "resolved",
        changes: outcome.changes,
        repoFiles: [{ path: candidate.manifestPath, content: edited }],
        cobumps: 0,
        warnings: [],
      };
    }
    return {
      candidate,
      status: outcome.status === "needs-build" ? "needs-build" : "unsolvable",
      changes: outcome.changes,
      repoFiles: [],
      cobumps: 0,
      warnings: [],
      reason: outcome.reason,
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolveGo(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-go-"));
  try {
    const gomod = await gh.getFile(ref, `${prefix}go.mod`, base);
    if (!gomod) throw new Error(`go.mod not found in ${dir}`);
    await writeFile(path.join(workdir, "go.mod"), gomod.content);
    const gosum = await gh.getFile(ref, `${prefix}go.sum`, base);
    if (gosum) await writeFile(path.join(workdir, "go.sum"), gosum.content);

    const r = await resolveGoModule(workdir, candidate.name, candidate.latestVersion);
    if (!r.ok) {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: r.stderr.split("\n").slice(-4).join("\n") };
    }
    return {
      candidate,
      status: "resolved",
      changes: [{ name: candidate.name, fromRange: candidate.currentRange, toRange: candidate.latestVersion, cobump: false }],
      repoFiles: r.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
      cobumps: 0,
      warnings: [],
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolveRuby(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  if (!candidate.currentVersion) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: "no pinned version to bump" };
  }
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-ruby-"));
  try {
    const gemfile = await gh.getFile(ref, candidate.manifestPath, base);
    if (!gemfile) throw new Error(`Gemfile not found in ${dir}`);
    await writeFile(
      path.join(workdir, "Gemfile"),
      editGemfilePin(gemfile.content, candidate.name, candidate.currentVersion, candidate.latestVersion),
    );
    const lock = await gh.getFile(ref, `${prefix}Gemfile.lock`, base);
    if (lock) await writeFile(path.join(workdir, "Gemfile.lock"), lock.content);

    const r = await resolveBundleLock(workdir);
    if (!r.ok) {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: r.stderr.split("\n").slice(-4).join("\n") };
    }
    return {
      candidate,
      status: "resolved",
      changes: [{ name: candidate.name, fromRange: candidate.currentRange, toRange: candidate.latestVersion, cobump: false }],
      repoFiles: r.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
      cobumps: 0,
      warnings: [],
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolveCargoCrate(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-cargo-"));
  try {
    const toml = await gh.getFile(ref, `${prefix}Cargo.toml`, base);
    if (!toml) throw new Error(`Cargo.toml not found in ${dir}`);
    const edited = editCargoToml(toml.content, candidate.name, candidate.currentRange, candidate.latestVersion);
    await writeFile(path.join(workdir, "Cargo.toml"), edited);
    // A src stub so cargo accepts the manifest without the real sources.
    await mkdir(path.join(workdir, "src"), { recursive: true });
    await writeFile(path.join(workdir, "src", "lib.rs"), "");

    const baseLock = await gh.getFile(ref, `${prefix}Cargo.lock`, base);
    if (baseLock) await writeFile(path.join(workdir, "Cargo.lock"), baseLock.content);

    const r = await runCargoUpdate(workdir, candidate.name, candidate.latestVersion);
    if (!r.ok) {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: r.stderr.split("\n").slice(-4).join("\n") };
    }
    const repoFiles = [{ path: `${prefix}Cargo.toml`, content: await readFile(path.join(workdir, "Cargo.toml"), "utf8") }];
    // Only commit Cargo.lock if the project already tracks one.
    if (baseLock) {
      repoFiles.push({ path: `${prefix}Cargo.lock`, content: await readFile(path.join(workdir, "Cargo.lock"), "utf8") });
    }
    return {
      candidate,
      status: "resolved",
      changes: [{ name: candidate.name, fromRange: candidate.currentRange, toRange: candidate.latestVersion, cobump: false }],
      repoFiles,
      cobumps: 0,
      warnings: [],
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolvePyproject(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  if (!candidate.currentVersion) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: "no pinned version to bump" };
  }
  const dir = candidate.dir;
  const prefix = dir === "." ? "" : `${dir}/`;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-pyproject-"));
  try {
    const pp = await gh.getFile(ref, candidate.manifestPath, base);
    if (!pp) throw new Error(`pyproject.toml not found in ${dir}`);
    await writeFile(
      path.join(workdir, "pyproject.toml"),
      editPyproject(pp.content, candidate.name, candidate.currentVersion, candidate.latestVersion),
    );
    const baseLock = await gh.getFile(ref, `${prefix}uv.lock`, base);
    if (baseLock) await writeFile(path.join(workdir, "uv.lock"), baseLock.content);

    const r = await uvLock(workdir);
    if (!r.ok) {
      return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: r.message.split("\n").slice(-4).join("\n") };
    }
    const repoFiles = [{ path: candidate.manifestPath, content: await readFile(path.join(workdir, "pyproject.toml"), "utf8") }];
    if (baseLock) repoFiles.push({ path: `${prefix}uv.lock`, content: await readFile(path.join(workdir, "uv.lock"), "utf8") });
    return {
      candidate,
      status: "resolved",
      changes: [{ name: candidate.name, fromRange: `==${candidate.currentVersion}`, toRange: `==${candidate.latestVersion}`, cobump: false }],
      repoFiles,
      cobumps: 0,
      warnings: [],
    };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function resolveDockerImage(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
): Promise<CandidateResolution> {
  // No lockfile / resolution step — just edit the FROM tag.
  const file = await gh.getFile(ref, candidate.manifestPath, base);
  if (!file) throw new Error(`${candidate.manifestPath} not found`);
  try {
    const edited = editDockerfileTag(file.content, candidate.name, candidate.currentRange, candidate.latestVersion);
    return {
      candidate,
      status: "resolved",
      changes: [{ name: candidate.name, fromRange: candidate.currentRange, toRange: candidate.latestVersion, cobump: false }],
      repoFiles: [{ path: candidate.manifestPath, content: edited }],
      cobumps: 0,
      warnings: [],
    };
  } catch (err) {
    return { candidate, status: "unsolvable", changes: [], repoFiles: [], cobumps: 0, warnings: [], reason: (err as Error).message };
  }
}

/**
 * Resolve a candidate against the live registry, dispatching by ecosystem.
 * npm: package-lock-only ladder (+ co-bump); pip: uv compile (requirements) or
 * uv lock (pyproject); gomod: go get; rubygems: bundle lock; cargo: cargo
 * update --precise. No third-party package code is executed in any path.
 */
export async function resolveCandidate(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  candidate: UpdateCandidate,
  pm: NpmPackageManager = "npm",
): Promise<CandidateResolution> {
  log.debug(`resolving ${candidate.ecosystem} ${candidate.name} in ${candidate.dir} (pm=${pm})`);
  if (candidate.ecosystem === "pip") {
    return candidate.manifestPath.endsWith("pyproject.toml")
      ? resolvePyproject(gh, ref, base, candidate)
      : resolvePip(gh, ref, base, candidate);
  }
  if (candidate.ecosystem === "gomod") return resolveGo(gh, ref, base, candidate);
  if (candidate.ecosystem === "rubygems") return resolveRuby(gh, ref, base, candidate);
  if (candidate.ecosystem === "cargo") return resolveCargoCrate(gh, ref, base, candidate);
  if (candidate.ecosystem === "docker") return resolveDockerImage(gh, ref, base, candidate);
  return resolveNpmFamily(gh, ref, base, candidate, pm);
}
