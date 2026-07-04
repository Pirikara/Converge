import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitHubClient, type RepoRef } from "../github/client.js";
import type { Config } from "../config/schema.js";
import type { EcosystemId } from "../adapters/types.js";
import { parseLockfile } from "../audit/lockfiles.js";
import { queryOsv, queryOsvBatch } from "../safety/osv.js";
import { vulnDecision } from "../safety/gate.js";
import { resolveLockfile } from "../resolve/npm-cli.js";
import { regeneratePnpmLockfile } from "../resolve/pnpm-cli.js";
import { updateComposerAll } from "../resolve/composer-cli.js";
import { goUpdateAll, extractTarballTo } from "../resolve/go-cli.js";
import { log } from "../logger.js";

export interface LockChange {
  name: string;
  from: string;
  to: string;
}

/** A new version this refresh would pull in that the F2 gate rejects. */
export interface RefreshBlock {
  name: string;
  version: string;
  reason: "malware" | "vulnerability";
  ids: string[];
}

export interface LockRefreshResult {
  ecosystem: EcosystemId;
  dir: string;
  /** The lockfile this refresh PR represents (repo-relative). */
  lockPath: string;
  /** Files to commit (the lockfile, plus go.mod for Go). */
  files: { path: string; content: string }[];
  changed: LockChange[];
  /** Subset of `changed` where the bump moves off an OSV-affected version. */
  securityFixed: (LockChange & { ids: string[] })[];
  /**
   * New versions this refresh would introduce that the safety gate blocks
   * (malware, or a high/critical vulnerability). Non-empty ⇒ do not open the PR.
   */
  blocked: RefreshBlock[];
  warnings: string[];
}

const OSV_ECO: Partial<Record<EcosystemId, string>> = { npm: "npm", composer: "Packagist", gomod: "Go" };
const osvVer = (eco: EcosystemId, v: string): string => (eco === "gomod" ? v.replace(/^v/, "") : v);

/** Regenerated files for one lockfile, or null if unavailable / failed / unchanged. */
type Regen = { files: { name: string; content: string }[]; warnings: string[] } | null;

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function readFileIf(dir: string, name: string): Promise<string | null> {
  try {
    await access(path.join(dir, name));
    return await readFile(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** npm/pnpm: seed manifest + lockfile, run the PM's within-range update. */
async function regenNpm(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  dir: string,
  lockName: string,
): Promise<Regen> {
  const prefix = dir === "." ? "" : `${dir}/`;
  const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
  if (!pkg) return null;
  // Only maintain repos that already have this lockfile.
  const existing = await gh.getFile(ref, `${prefix}${lockName}`, base);
  if (!existing) return null;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-lm-npm-"));
  try {
    await writeFile(path.join(workdir, "package.json"), pkg.content);
    // Regenerate WITHOUT seeding the old lockfile: a fresh resolve picks the
    // latest version in each package.json range. Unlike `npm/pnpm update`, this
    // leaves the declared specifiers untouched, so the lockfile stays consistent
    // with package.json (--frozen-lockfile passes).
    const r = lockName === "pnpm-lock.yaml" ? await regeneratePnpmLockfile(workdir) : await resolveLockfile(workdir);
    if (!r.ok) {
      log.debug(`lockfile refresh ${lockName} failed: ${r.stderr.split("\n").slice(-2).join(" ")}`);
      return null;
    }
    const content = await readFileIf(workdir, lockName);
    if (content == null) return null;
    return { files: [{ name: lockName, content }], warnings: "warnings" in r ? r.warnings : [] };
  } finally {
    await cleanup(workdir);
  }
}

/** composer: `composer update` (all) within composer.json ranges. */
async function regenComposer(gh: GitHubClient, ref: RepoRef, base: string, dir: string): Promise<Regen> {
  const prefix = dir === "." ? "" : `${dir}/`;
  const cj = await gh.getFile(ref, `${prefix}composer.json`, base);
  const cl = await gh.getFile(ref, `${prefix}composer.lock`, base);
  if (!cj || !cl) return null;
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-lm-composer-"));
  try {
    await writeFile(path.join(workdir, "composer.json"), cj.content);
    await writeFile(path.join(workdir, "composer.lock"), cl.content);
    const r = await updateComposerAll(workdir);
    if (!r.ok) {
      log.debug(`lockfile refresh composer failed: ${r.stderr.split("\n").slice(-2).join(" ")}`);
      return null;
    }
    const content = await readFileIf(workdir, "composer.lock");
    if (content == null) return null;
    return { files: [{ name: "composer.lock", content }], warnings: [] };
  } finally {
    await cleanup(workdir);
  }
}

/** Go: fetch source, `go get -u ./...` + `go mod tidy` (needs the module source). */
async function regenGo(gh: GitHubClient, ref: RepoRef, base: string, dir: string): Promise<Regen> {
  const workdir = await mkdtemp(path.join(tmpdir(), "converge-lm-go-"));
  try {
    const src = await gh.downloadTarball(ref, base);
    await extractTarballTo(src, workdir);
    const moduleDir = dir === "." ? workdir : path.join(workdir, dir);
    await access(path.join(moduleDir, "go.mod"));
    const r = await goUpdateAll(moduleDir);
    if (!r.ok) {
      log.debug(`lockfile refresh go failed: ${r.stderr.split("\n").slice(-2).join(" ")}`);
      return null;
    }
    return { files: r.files, warnings: [] };
  } catch (err) {
    log.debug(`lockfile refresh go unavailable: ${(err as Error).message}`);
    return null;
  } finally {
    await cleanup(workdir);
  }
}

export function highest(versions: string[]): string {
  return [...versions].sort((a, b) => {
    const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10));
    const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return a.localeCompare(b);
  })[versions.length - 1]!;
}

function versionsByName(lockName: string, content: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of parseLockfile(lockName, content)?.packages ?? []) {
    const arr = m.get(p.name) ?? [];
    arr.push(p.version);
    m.set(p.name, arr);
  }
  return m;
}

/** Packages whose locked version set changed (present in both old and new). */
export function diffLocks(lockName: string, oldC: string, newC: string): LockChange[] {
  const oldM = versionsByName(lockName, oldC);
  const newM = versionsByName(lockName, newC);
  const changed: LockChange[] = [];
  for (const [name, newVers] of newM) {
    const oldVers = oldM.get(name);
    if (!oldVers) continue;
    const newSet = new Set(newVers);
    const same = oldVers.length === newVers.length && oldVers.every((v) => newSet.has(v));
    if (same) continue;
    const from = highest(oldVers);
    const to = highest(newVers);
    if (from !== to) changed.push({ name, from, to });
  }
  return changed;
}

/** Which of the changed packages moved off an OSV-affected version. */
export async function securityFixed(
  ecosystem: EcosystemId,
  changed: LockChange[],
): Promise<(LockChange & { ids: string[] })[]> {
  const osv = OSV_ECO[ecosystem];
  if (!osv || changed.length === 0) return [];
  const screen = await queryOsvBatch(osv, changed.map((c) => ({ name: c.name, version: osvVer(ecosystem, c.from) })));
  const fixed: (LockChange & { ids: string[] })[] = [];
  for (let i = 0; i < changed.length; i++) {
    if ((screen[i]?.length ?? 0) === 0) continue; // old version wasn't affected
    const c = changed[i]!;
    const before = new Set((await queryOsv(osv, c.name, osvVer(ecosystem, c.from))).flatMap((v) => [v.id, ...v.aliases]));
    if (before.size === 0) continue;
    const after = new Set((await queryOsv(osv, c.name, osvVer(ecosystem, c.to))).flatMap((v) => [v.id, ...v.aliases]));
    const resolved = [...before].filter((id) => !after.has(id));
    if (resolved.length > 0) fixed.push({ ...c, ids: resolved });
  }
  return fixed;
}

/**
 * Vet the *new* versions a refresh would introduce against the F2 gate (same
 * policy as routine updates): malware and high/critical vulnerabilities block
 * the refresh; lesser advisories are surfaced as warnings. A lockfile is atomic,
 * so a single blocked version rejects the whole refresh — Converge won't pull in
 * malware just to keep other deps fresh.
 */
export async function vetNewVersions(
  policy: Config["safety"],
  ecosystem: EcosystemId,
  changed: LockChange[],
): Promise<{ blocked: RefreshBlock[]; warnings: string[] }> {
  const osv = OSV_ECO[ecosystem];
  if (!osv || changed.length === 0) return { blocked: [], warnings: [] };
  const screen = await queryOsvBatch(osv, changed.map((c) => ({ name: c.name, version: osvVer(ecosystem, c.to) })));
  const blocked: RefreshBlock[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < changed.length; i++) {
    if ((screen[i]?.length ?? 0) === 0) continue; // new version is clean
    const c = changed[i]!;
    const vulns = await queryOsv(osv, c.name, osvVer(ecosystem, c.to));
    const blocking = vulns.filter((v) => vulnDecision(v, policy) === "block");
    if (blocking.length > 0) {
      blocked.push({
        name: c.name,
        version: c.to,
        reason: blocking.some((v) => v.malware) ? "malware" : "vulnerability",
        ids: blocking.map((v) => v.id),
      });
    } else {
      const warn = vulns.filter((v) => vulnDecision(v, policy) === "warn");
      if (warn.length > 0) warnings.push(`\`${c.name}@${c.to}\` introduces ${warn[0]!.severity} advisory ${warn.map((v) => v.id).join(", ")}`);
    }
  }
  return { blocked, warnings };
}

async function paths(gh: GitHubClient, ref: RepoRef, base: string, lockName: string): Promise<string[]> {
  return gh.findManifestPaths(ref, base, lockName);
}

/**
 * Lockfile refresh: for each lockfile, regenerate it so dependencies
 * move up to the latest versions allowed by the manifest ranges — no manifest
 * edits, no overrides — and report what changed and which OSV advisories that
 * clears. One result per lockfile. v1 covers npm/pnpm, Composer, and Go.
 */
export async function lockRefresh(
  gh: GitHubClient,
  ref: RepoRef,
  config: Config,
  base: string,
): Promise<LockRefreshResult[]> {
  if (!config.lockRefresh.enabled) return [];
  const out: LockRefreshResult[] = [];

  const enabled = (eco: EcosystemId): boolean => config.ecosystems[eco]?.enabled ?? false;

  const dirOf = (lockPath: string): string => (path.posix.dirname(lockPath) === "." ? "." : path.posix.dirname(lockPath));

  const collect = async (
    ecosystem: EcosystemId,
    lockName: string,
    regen: (dir: string) => Promise<Regen>,
  ): Promise<void> => {
    for (const lockPath of await paths(gh, ref, base, lockName)) {
      const dir = dirOf(lockPath);
      const old = await gh.getFile(ref, lockPath, base);
      if (!old) continue;
      const r = await regen(dir);
      if (!r) continue;
      const newLock = r.files.find((f) => f.name === lockName);
      if (!newLock || newLock.content === old.content) continue;
      const changed = diffLocks(lockName, old.content, newLock.content);
      if (changed.length === 0) continue;
      const prefix = dir === "." ? "" : `${dir}/`;
      const vet = await vetNewVersions(config.safety, ecosystem, changed);
      out.push({
        ecosystem,
        dir,
        lockPath,
        files: r.files.map((f) => ({ path: `${prefix}${f.name}`, content: f.content })),
        changed,
        securityFixed: await securityFixed(ecosystem, changed),
        blocked: vet.blocked,
        warnings: [...r.warnings, ...vet.warnings],
      });
    }
  };

  if (enabled("npm")) {
    await collect("npm", "package-lock.json", (dir) => regenNpm(gh, ref, base, dir, "package-lock.json"));
    await collect("npm", "pnpm-lock.yaml", (dir) => regenNpm(gh, ref, base, dir, "pnpm-lock.yaml"));
  }
  if (enabled("composer")) await collect("composer", "composer.lock", (dir) => regenComposer(gh, ref, base, dir));
  if (enabled("gomod")) await collect("gomod", "go.sum", (dir) => regenGo(gh, ref, base, dir));

  return out;
}
