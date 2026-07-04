import pc from "picocolors";
import {
  GitHubClient,
  parseRepoRef,
  resolveToken,
  type RepoRef,
} from "../github/client.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import { stripJsonComments } from "../config/load.js";
import { selectCandidates, branchName, streamId, type UpdateType } from "../core/plan.js";
import { resolveCandidate, resolveGroup, type CandidateResolution, type GroupResolution } from "../core/apply.js";
import { partitionGroups } from "../core/groups.js";
import { securityCandidates } from "../core/security.js";
import { isRoutineAllowed } from "../core/schedule.js";
import { lockRefresh } from "../core/lock-refresh.js";
import { renderPrBody, renderPrTitle, renderDockerPrBody, renderGroupPrBody, renderActionsPrBody, renderTerraformPrBody, renderNugetPrBody, renderComposerPrBody, renderHelmPrBody, renderMavenPrBody, renderLockRefreshPrBody } from "../core/pr-body.js";
import { evaluateSafety } from "../safety/gate.js";
import { provenanceStatus } from "../safety/provenance.js";
import type { SafetyVerdict } from "../safety/types.js";
import { analyzeImpact, type ImpactReport } from "../impact/analyze.js";
import { isSourceFile, isPythonSourceFile, isGoSourceFile, isRubySourceFile, isRustSourceFile, type SourceFile } from "../impact/usage.js";
import { detectDeprecation, type DeprecationFinding } from "../deprecation/detect.js";
import { auditIntroduced } from "../core/update-audit.js";
import type { AuditFinding } from "../audit/audit.js";
import {
  decidePackageManager,
  isResolvable,
  type NpmPackageManager,
} from "../resolve/pm-detect.js";
import { fetchPackageMeta } from "../adapters/npm/registry.js";
import { fetchPyPiMeta } from "../adapters/pip/pypi.js";
import { fetchGoMeta } from "../adapters/gomod/proxy.js";
import { fetchGemMeta } from "../adapters/rubygems/rubygems.js";
import { fetchCrateMeta } from "../adapters/cargo/cratesio.js";
import { fetchActionMeta } from "../adapters/github-actions/index.js";
import { fetchTerraformMeta } from "../adapters/terraform/index.js";
import { fetchNuGetMeta } from "../adapters/nuget/index.js";
import { fetchComposerMeta } from "../adapters/composer/index.js";
import { fetchMavenMeta } from "../adapters/maven/index.js";
import type { EcosystemId, PackageMeta, UpdateCandidate } from "../adapters/types.js";
import { log } from "../logger.js";

const OSV_ECOSYSTEM: Record<EcosystemId, string> = {
  npm: "npm",
  pip: "PyPI",
  gomod: "Go",
  rubygems: "RubyGems",
  cargo: "crates.io",
  docker: "", // base images aren't OSV-indexed; Docker is scan-only
  "github-actions": "GitHub Actions",
  terraform: "", // registry providers/modules aren't OSV-indexed; scan-only
  nuget: "NuGet",
  composer: "Packagist",
  helm: "", // charts aren't OSV-indexed; scan-only
  maven: "Maven",
};

function getMeta(c: UpdateCandidate): Promise<PackageMeta> {
  if (c.ecosystem === "pip") return fetchPyPiMeta(c.name);
  if (c.ecosystem === "gomod") return fetchGoMeta(c.name);
  if (c.ecosystem === "rubygems") return fetchGemMeta(c.name);
  if (c.ecosystem === "cargo") return fetchCrateMeta(c.name);
  if (c.ecosystem === "github-actions") return fetchActionMeta(c.name);
  if (c.ecosystem === "terraform") return fetchTerraformMeta(c.name);
  if (c.ecosystem === "nuget") return fetchNuGetMeta(c.name);
  if (c.ecosystem === "composer") return fetchComposerMeta(c.name);
  if (c.ecosystem === "maven") return fetchMavenMeta(c.name);
  return fetchPackageMeta(c.name);
}

function sourcePredicate(c: UpdateCandidate): (p: string) => boolean {
  if (c.ecosystem === "pip") return isPythonSourceFile;
  if (c.ecosystem === "gomod") return isGoSourceFile;
  if (c.ecosystem === "rubygems") return isRubySourceFile;
  if (c.ecosystem === "cargo") return isRustSourceFile;
  return isSourceFile;
}

/** OSV indexes Go versions without the leading `v`. */
function osvVersion(c: UpdateCandidate): string {
  return c.ecosystem === "gomod" ? c.latestVersion.replace(/^v/, "") : c.latestVersion;
}

const PROBE_LOCKFILES = [
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
];

const SOURCE_FILE_CAP = 500;
const STALE_DAYS = 365 * 2;

export interface RunOptions {
  apply?: boolean;
  token?: string;
  types?: string;
  limit?: string;
  /** Override config `updateStrategy` ("latest" | "in-range"). */
  strategy?: string;
  /** Only remediate vulnerabilities; skip routine version updates. */
  securityOnly?: boolean;
}

const VALID_TYPES: UpdateType[] = ["major", "minor", "patch"];

function parseTypes(input: string | undefined): UpdateType[] {
  if (!input) return ["minor", "patch"];
  const types = input
    .split(",")
    .map((s) => s.trim())
    .filter((t): t is UpdateType => VALID_TYPES.includes(t as UpdateType));
  return types.length > 0 ? types : ["minor", "patch"];
}

async function loadRepoConfig(gh: GitHubClient, ref: RepoRef, base: string): Promise<Config> {
  const file = await gh.getFile(ref, "converge.json", base);
  if (!file) return ConfigSchema.parse({});
  return ConfigSchema.parse(JSON.parse(stripJsonComments(file.content)));
}

function printResolution(res: CandidateResolution): void {
  if (res.status === "unsolvable") {
    process.stdout.write(`  ${pc.red("✗ unresolvable")} — ${res.reason ?? "conflict"}\n`);
    return;
  }
  if (res.status === "needs-build") {
    process.stdout.write(`  ${pc.yellow("⚠ needs build")} — source-only dependency; skipped (no code execution)\n`);
    return;
  }
  const tag = res.status === "resolved-cobump" ? pc.yellow(`co-bump×${res.cobumps}`) : pc.green("direct");
  process.stdout.write(`  ${pc.green("✓ resolved")} (${tag})\n`);
  for (const ch of res.changes) {
    const mark = ch.cobump ? pc.yellow("  + ") : "  • ";
    process.stdout.write(`${mark}${ch.name}: ${ch.fromRange} → ${ch.toRange}\n`);
  }
  for (const w of res.warnings) {
    process.stdout.write(`  ${pc.yellow(`⚠ ${w}`)}\n`);
  }
}

function printSafety(verdict: SafetyVerdict): void {
  if (verdict.signals.length === 0) {
    process.stdout.write(`  ${pc.green("✓ safety")} no known advisories, cooldown ok\n`);
    return;
  }
  const color =
    verdict.decision === "block"
      ? pc.red
      : verdict.decision === "hold"
        ? pc.yellow
        : verdict.decision === "warn"
          ? pc.yellow
          : pc.green;
  process.stdout.write(`  ${color(`⚑ safety: ${verdict.decision}`)}\n`);
  for (const s of verdict.signals) {
    process.stdout.write(`    ${pc.dim(`- ${s.kind} (${s.severity}): ${s.detail}`)}\n`);
  }
}

function riskColor(risk: ImpactReport["risk"]["risk"]): (s: string) => string {
  return risk === "high" ? pc.red : risk === "medium" ? pc.yellow : pc.green;
}

function printImpact(impact: ImpactReport): void {
  const used =
    impact.usage.files === 0
      ? "not imported directly"
      : `used in ${impact.usage.files} file(s)`;
  process.stdout.write(
    `  ${riskColor(impact.risk.risk)(`◆ impact: risk ${impact.risk.risk}`)} ${pc.dim(`(${used})`)}\n`,
  );
}

function printDeprecation(findings: DeprecationFinding[]): void {
  if (findings.length === 0) return;
  for (const f of findings) {
    const c = f.severity === "warn" ? pc.yellow : pc.dim;
    const rep = f.replacement ? ` → ${f.replacement}` : "";
    process.stdout.write(`  ${c(`⏳ ${f.kind}: ${f.detail}${rep}`)}\n`);
  }
}

function printIntroduced(findings: AuditFinding[]): void {
  if (findings.length === 0) return;
  const malware = findings.some((f) => f.vulns.some((v) => v.malware));
  const color = malware ? pc.red : pc.yellow;
  process.stdout.write(
    `  ${color(`⚡ introduces ${findings.length} risky transitive package(s)`)}\n`,
  );
  for (const f of findings.slice(0, 5)) {
    const m = f.vulns.some((v) => v.malware);
    process.stdout.write(
      `    ${pc.dim(`- ${m ? "MALWARE" : "vuln"} ${f.name}@${f.version} (${f.vulns[0]!.id})`)}\n`,
    );
  }
}

function sanitizeBranch(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

type RebaseMode = Config["rebase"];

/** Should a stale (behind-base) PR be rebased, per the configured policy? */
async function shouldRebase(
  gh: GitHubClient,
  ref: RepoRef,
  mode: RebaseMode,
  prNumber: number,
  behind: number,
): Promise<boolean> {
  if (behind === 0 || mode === "never") return false;
  if (mode === "behind") return true;
  return gh.prConflicting(ref, prNumber); // "conflicting"
}

/**
 * Create the stream PR, or refresh the existing one in place (same branch) so a
 * dependency has one live PR that moves forward — never a pile-up per version.
 *
 * Refreshes when the target moved (title changed) or the branch fell behind base
 * and the rebase policy says so. The files are always re-resolved against the
 * current base, so a refresh rebases the branch and regenerates a clean lockfile
 * (no textual merge → no conflict). A PR a human has pushed extra commits to
 * (ahead of base by more than Converge's single commit) is left untouched.
 */
async function upsertPr(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  rebase: RebaseMode,
  spec: { branch: string; title: string; body: string; files: { path: string; content: string }[] },
): Promise<void> {
  const existing = await gh.findOpenPr(ref, spec.branch);
  const write = async (): Promise<string> => {
    const baseSha = await gh.getBranchSha(ref, base);
    await gh.commitFiles(ref, { branch: spec.branch, baseSha, message: spec.title, files: spec.files });
    return baseSha;
  };

  if (!existing) {
    await write();
    const pr = await gh.createPr(ref, { head: spec.branch, base, title: spec.title, body: spec.body });
    process.stdout.write(`  ${pc.green("created")} PR #${pr.number} → ${pr.url}\n`);
    return;
  }

  const { ahead, behind } = await gh.compareBranch(ref, base, spec.branch);
  if (ahead > 1) {
    // A human pushed to the branch — never clobber their work.
    process.stdout.write(`  ${pc.yellow("⚠ manual commits")} on PR #${existing.number} ${pc.dim("(left untouched)")}\n`);
    return;
  }
  const targetChanged = existing.title !== spec.title;
  const rebasing = await shouldRebase(gh, ref, rebase, existing.number, behind);
  if (!targetChanged && !rebasing) {
    process.stdout.write(`  up to date → PR #${existing.number} ${pc.dim("(no change)")}\n`);
    return;
  }
  await write();
  await gh.updatePr(ref, existing.number, { title: spec.title, body: spec.body });
  const why = targetChanged ? "new target" : "rebased onto base";
  process.stdout.write(`  ${pc.yellow("refreshed")} PR #${existing.number} ${pc.dim(`(${why})`)}\n`);
}

async function openPr(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  res: CandidateResolution,
  safety: SafetyVerdict,
  impact: ImpactReport,
  deprecation: DeprecationFinding[],
  introduced: AuditFinding[],
  rebase: RebaseMode,
): Promise<void> {
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(res.candidate),
    title: renderPrTitle(res.candidate, res),
    body: renderPrBody(res.candidate, res, safety, impact, deprecation, introduced),
    files: res.repoFiles,
  });
}

async function openPrDocker(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} image from ${c.currentRange} to ${c.latestVersion}`,
    body: renderDockerPrBody(c),
    files: res.repoFiles,
  });
}

async function openPrNuget(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, safety: SafetyVerdict, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} from ${c.currentRange} to ${c.latestVersion}`,
    body: renderNugetPrBody(c, safety),
    files: res.repoFiles,
  });
}

async function openPrMaven(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, safety: SafetyVerdict, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} from ${c.currentRange} to ${c.latestVersion}`,
    body: renderMavenPrBody(c, safety),
    files: res.repoFiles,
  });
}

async function openPrComposer(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, safety: SafetyVerdict, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  const to = c.writeRange ?? c.latestVersion;
  const lockUpdated = res.repoFiles.some((f) => f.path.endsWith("composer.lock"));
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} from ${c.currentRange} to ${to}`,
    body: renderComposerPrBody(c, safety, lockUpdated),
    files: res.repoFiles,
  });
}

async function openPrTerraform(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} from ${c.currentRange} to ${c.latestVersion}`,
    body: renderTerraformPrBody(c),
    files: res.repoFiles,
  });
}

async function openPrHelm(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  await upsertPr(gh, ref, base, rebase, {
    branch: branchName(c),
    title: `bump ${c.name} chart from ${c.currentRange} to ${c.latestVersion}`,
    body: renderHelmPrBody(c),
    files: res.repoFiles,
  });
}

async function openPrActions(gh: GitHubClient, ref: RepoRef, base: string, res: CandidateResolution, safety: SafetyVerdict, rebase: RebaseMode): Promise<void> {
  const c = res.candidate;
  // The manifest dir (`.github/workflows`) can't seed a branch (a ref component
  // may not start with a dot), and the same action can appear in multiple
  // workflows — key on the workflow file stem + version-less stream id.
  const stem = sanitizeBranch((c.manifestPath.split("/").pop() ?? "").replace(/\.ya?ml$/i, ""));
  await upsertPr(gh, ref, base, rebase, {
    branch: `converge/github-actions/${stem}-${streamId(c)}`,
    title: `bump ${c.name} action from ${c.currentRange} to ${c.latestVersion}`,
    body: renderActionsPrBody(c, safety),
    files: res.repoFiles,
  });
}

async function openPrGroup(gh: GitHubClient, ref: RepoRef, base: string, gres: GroupResolution, introduced: AuditFinding[], rebase: RebaseMode): Promise<void> {
  const c0 = gres.candidates[0]!;
  // Title encodes the members' targets so an unchanged group is a no-op while a
  // changed one refreshes the same PR.
  const summary = gres.changes.map((ch) => `${ch.name}@${ch.toRange}`).join(", ");
  await upsertPr(gh, ref, base, rebase, {
    branch: `converge/group/${sanitizeBranch(gres.groupName)}-${sanitizeBranch(c0.dir)}`,
    title: `group ${gres.groupName}: ${summary}`,
    body: renderGroupPrBody(gres.groupName, gres.changes, introduced),
    files: gres.repoFiles,
  });
}

export async function runRun(repoInput: string, opts: RunOptions): Promise<number> {
  const ref = parseRepoRef(repoInput);
  const gh = new GitHubClient(resolveToken(opts.token));

  const base = await gh.getDefaultBranch(ref);
  let config = await loadRepoConfig(gh, ref, base);
  if (opts.strategy === "latest" || opts.strategy === "in-range") {
    config = { ...config, updateStrategy: opts.strategy };
  }
  const allow = parseTypes(opts.types);
  const limit = Math.max(1, Number(opts.limit ?? "5") || 5);
  // Routine updates run only outside `--security-only` and within the configured
  // schedule window; security fixes always run. So a single frequent workflow
  // keeps vulnerabilities fresh while routine PRs land only in their window.
  const routineAllowed = opts.securityOnly !== true && isRoutineAllowed(new Date(), config.schedule);

  log.info(
    `${ref.owner}/${ref.repo} — ${routineAllowed ? `proposing [${allow.join(", ")}] updates` : pc.red("security fixes only")} ` +
      `(limit ${limit}, ${opts.apply ? pc.red("APPLY") : pc.cyan("dry-run")})`,
  );

  const { selected } = routineAllowed
    ? await selectCandidates(gh, ref, config, { allow, limit })
    : { selected: [] as UpdateCandidate[] };

  // Security remediation (F2.2): a direct dep whose *current* version is
  // vulnerable gets a fix candidate regardless of the type filter — and it
  // supersedes any routine candidate for the same dependency.
  const security = await securityCandidates(gh, ref, config, base);
  const depKey = (c: UpdateCandidate): string => `${c.ecosystem}:${c.dir}:${c.name}`;
  const secKeys = new Set(security.map(depKey));
  const candidates = [...security, ...selected.filter((c) => !secKeys.has(depKey(c)))];
  if (security.length > 0) {
    log.info(`${pc.red(`${security.length} security fix(es)`)} for vulnerable direct dependencies`);
  }

  // Lock file refresh runs independently of routine/security candidates, so only
  // short-circuit when it won't run either.
  const willRefresh = config.lockRefresh.enabled && routineAllowed;
  if (candidates.length === 0) {
    log.info(pc.green("no eligible updates ✓"));
    if (!willRefresh) return 0;
  }

  const sourceCache = new Map<string, SourceFile[]>();
  const getSources = async (c: UpdateCandidate): Promise<SourceFile[]> => {
    const key = `${c.ecosystem}:${c.dir}`;
    const cached = sourceCache.get(key);
    if (cached) return cached;
    const files = await gh.fetchSourceFiles(ref, base, {
      dirPrefix: c.dir,
      predicate: sourcePredicate(c),
      cap: SOURCE_FILE_CAP,
    });
    sourceCache.set(key, files);
    return files;
  };

  // Detect the package manager per directory so we never write a foreign
  // lockfile (e.g. a package-lock.json into a pnpm repo).
  const pmCache = new Map<string, NpmPackageManager>();
  const getPm = async (dir: string): Promise<NpmPackageManager> => {
    const cached = pmCache.get(dir);
    if (cached) return cached;
    const prefix = dir === "." ? "" : `${dir}/`;
    const pkg = await gh.getFile(ref, `${prefix}package.json`, base);
    let packageManagerField: string | null = null;
    if (pkg) {
      try {
        packageManagerField = (JSON.parse(pkg.content) as { packageManager?: string })
          .packageManager ?? null;
      } catch {
        /* ignore */
      }
    }
    let lockfiles: string[] = [];
    if (!packageManagerField) {
      const found = await Promise.all(
        PROBE_LOCKFILES.map(async (lf) =>
          (await gh.getFile(ref, `${prefix}${lf}`, base)) ? lf : null,
        ),
      );
      lockfiles = found.filter((x): x is string => x != null);
    }
    const pm = decidePackageManager({ packageManagerField, lockfiles });
    pmCache.set(dir, pm);
    return pm;
  };

  let resolved = 0;
  let unsolvable = 0;
  let blocked = 0;
  let reportOnly = 0;

  const deprecationOf = (c: UpdateCandidate, meta: PackageMeta): DeprecationFinding[] =>
    detectDeprecation(
      { name: c.name, currentVersion: c.currentVersion, targetVersion: c.latestVersion },
      meta,
      { staleDays: STALE_DAYS, now: Date.now() },
    );

  const safetyOf = (c: UpdateCandidate, meta: PackageMeta) =>
    evaluateSafety(
      {
        ecosystem: OSV_ECOSYSTEM[c.ecosystem],
        name: c.name,
        version: osvVersion(c),
        publishedAt: meta.publishedAt[c.latestVersion],
        provenance:
          c.ecosystem === "npm"
            ? provenanceStatus(meta, c.currentVersion, c.latestVersion)
            : undefined,
      },
      config.safety,
    );

  // Grouping (F1): bundle configured deps in the same ecosystem+dir into one PR.
  const { groups, individual } = partitionGroups(candidates, config.groups);

  for (const group of groups) {
    const head = group.candidates[0]!;
    process.stdout.write(
      `\n${pc.bold(`group: ${group.name}`)} ` +
        `${pc.dim(`(${group.candidates.length} updates, ${head.ecosystem}, ${head.dir})`)}\n`,
    );

    // F2 gate per member; drop unsafe/held members from the group.
    const safe: UpdateCandidate[] = [];
    for (const candidate of group.candidates) {
      const meta = await getMeta(candidate);
      const verdict = await safetyOf(candidate, meta);
      if (verdict.decision === "block" || verdict.decision === "hold") {
        blocked++;
        process.stdout.write(
          `  ${pc.red("⛔")} ${candidate.name} — ` +
            `${verdict.decision === "block" ? "unsafe target" : "within cooldown"} (dropped from group)\n`,
        );
        continue;
      }
      safe.push(candidate);
    }
    if (safe.length === 0) continue;
    if (safe.length === 1) {
      individual.push(safe[0]!); // a group of one is just an individual PR
      continue;
    }

    let pm: NpmPackageManager = "npm";
    if (head.ecosystem === "npm") {
      pm = await getPm(head.dir);
      if (!isResolvable(pm)) {
        process.stdout.write(
          `  ${pc.yellow("⊘ group skipped")} — ${pm} not supported; processing members individually\n`,
        );
        individual.push(...safe);
        continue;
      }
    }

    const gres = await resolveGroup(gh, ref, base, group.name, safe, pm);
    if (!gres) {
      process.stdout.write(
        `  ${pc.yellow(`⊘ grouping not wired for ${head.ecosystem}`)}; processing members individually\n`,
      );
      individual.push(...safe);
      continue;
    }
    if (gres.status === "unsolvable") {
      unsolvable++;
      process.stdout.write(
        `  ${pc.red("✗ group unsolvable")}${gres.reason ? ` — ${gres.reason}` : ""}\n`,
      );
      continue;
    }
    for (const ch of gres.changes) {
      process.stdout.write(`  ${pc.green("✓")} ${ch.name}: ${ch.fromRange} → ${ch.toRange}\n`);
    }

    const introduced = await auditIntroduced(gh, ref, base, gres.repoFiles);
    printIntroduced(introduced);
    if (introduced.some((f) => f.vulns.some((v) => v.malware))) {
      blocked++;
      process.stdout.write(
        `  ${pc.red("⛔ skipped")} — group introduces transitive malware (no PR)\n`,
      );
      continue;
    }
    resolved++;
    if (opts.apply) {
      try {
        await openPrGroup(gh, ref, base, gres, introduced, config.rebase);
      } catch (err) {
        log.error(`group ${group.name}: ${(err as Error).message}`);
      }
    }
  }

  for (const candidate of individual) {
    const sec = candidate.security ? pc.red(` 🔒 security/${candidate.security.severity}`) : "";
    process.stdout.write(
      `\n${pc.bold(candidate.name)} ${pc.dim(candidate.currentVersion ?? candidate.currentRange)} → ` +
        `${pc.bold(candidate.latestVersion)} [${candidate.updateType}]${sec} ` +
        `${pc.dim(`(${candidate.ecosystem}, ${candidate.dir})`)}\n`,
    );

    // Docker base images: no OSV / lockfile / source usage — just bump the tag.
    if (candidate.ecosystem === "docker") {
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrDocker(gh, ref, base, res, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // Terraform: registry providers/modules aren't OSV-indexed — rewrite the
    // version constraint, no lockfile/safety/impact (mirrors Docker).
    if (candidate.ecosystem === "terraform") {
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrTerraform(gh, ref, base, res, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // Helm: charts aren't OSV-indexed — rewrite the dependency version
    // constraint in Chart.yaml, no lockfile/safety/impact (mirrors Terraform).
    if (candidate.ecosystem === "helm") {
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrHelm(gh, ref, base, res, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // GitHub Actions: no lockfile / source usage. Still F2-gated via OSV's
    // "GitHub Actions" advisory feed (supply-chain safety, P4), then bump the ref.
    if (candidate.ecosystem === "github-actions") {
      const meta = await getMeta(candidate);
      const verdict = await safetyOf(candidate, meta);
      printSafety(verdict);
      if (verdict.decision === "block" || (verdict.decision === "hold" && !candidate.security)) {
        blocked++;
        process.stdout.write(
          `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
        );
        continue;
      }
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrActions(gh, ref, base, res, verdict, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // NuGet: OSV-indexed (F2 safety applies), but no lockfile regen (dotnet not
    // run) — gate on safety, then rewrite the PackageReference version.
    if (candidate.ecosystem === "nuget") {
      const meta = await getMeta(candidate);
      const verdict = await safetyOf(candidate, meta);
      printSafety(verdict);
      if (verdict.decision === "block" || (verdict.decision === "hold" && !candidate.security)) {
        blocked++;
        process.stdout.write(
          `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
        );
        continue;
      }
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrNuget(gh, ref, base, res, verdict, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // Composer: OSV-indexed (F2 safety via "Packagist"); no lockfile regen
    // (Composer not run) — gate on safety, then rewrite the composer.json constraint.
    if (candidate.ecosystem === "composer") {
      const meta = await getMeta(candidate);
      const verdict = await safetyOf(candidate, meta);
      printSafety(verdict);
      if (verdict.decision === "block" || (verdict.decision === "hold" && !candidate.security)) {
        blocked++;
        process.stdout.write(
          `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
        );
        continue;
      }
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrComposer(gh, ref, base, res, verdict, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // Maven/Gradle: OSV-indexed (F2 safety via "Maven"); no build/lockfile —
    // gate on safety, then rewrite the declared version.
    if (candidate.ecosystem === "maven") {
      const meta = await getMeta(candidate);
      const verdict = await safetyOf(candidate, meta);
      printSafety(verdict);
      if (verdict.decision === "block" || (verdict.decision === "hold" && !candidate.security)) {
        blocked++;
        process.stdout.write(
          `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
        );
        continue;
      }
      const res = await resolveCandidate(gh, ref, base, candidate);
      printResolution(res);
      if (res.status !== "resolved" && res.status !== "resolved-cobump") {
        unsolvable++;
        continue;
      }
      resolved++;
      if (opts.apply) {
        try {
          await openPrMaven(gh, ref, base, res, verdict, config.rebase);
        } catch (err) {
          log.error(`${candidate.name}: ${(err as Error).message}`);
        }
      }
      continue;
    }

    // F2 gate first: never resolve/install a dangerous or held version. A
    // security fix bypasses the cooldown "hold" (we want the patch now) but a
    // "block" (malware/vuln target) still stops it.
    const meta = await getMeta(candidate);
    const verdict = await safetyOf(candidate, meta);
    printSafety(verdict);
    const heldByCooldown = verdict.decision === "hold" && !candidate.security;
    if (verdict.decision === "block" || heldByCooldown) {
      blocked++;
      process.stdout.write(
        `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
      );
      continue;
    }

    // Guard (npm family only): never write a foreign lockfile for an
    // unsupported package manager — degrade to a read-only report.
    let pm: NpmPackageManager = "npm";
    if (candidate.ecosystem === "npm") {
      pm = await getPm(candidate.dir);
      process.stdout.write(`  ${pc.dim(`pm: ${pm}`)}\n`);
      if (!isResolvable(pm)) {
        printImpact(analyzeImpact(candidate, await getSources(candidate), 0, verdict.decision));
        printDeprecation(deprecationOf(candidate, meta));
        process.stdout.write(
          `  ${pc.yellow("⊘ resolution skipped")} — ${pm} lockfiles not yet supported (report only, no PR)\n`,
        );
        reportOnly++;
        continue;
      }
    }

    const res = await resolveCandidate(gh, ref, base, candidate, pm);
    printResolution(res);
    if (res.status === "unsolvable") {
      unsolvable++;
      continue;
    }
    if (res.status === "needs-build") {
      reportOnly++;
      continue;
    }
    resolved++;

    // Transitive audit: what does this update INTRODUCE into the dependency
    // tree? Block PRs that pull in malware; flag ones that pull in vulns.
    const introduced = await auditIntroduced(gh, ref, base, res.repoFiles);
    printIntroduced(introduced);
    if (introduced.some((f) => f.vulns.some((v) => v.malware))) {
      resolved--;
      blocked++;
      process.stdout.write(
        `  ${pc.red("⛔ skipped")} — update introduces transitive malware (no PR)\n`,
      );
      continue;
    }

    const impact = analyzeImpact(candidate, await getSources(candidate), res.cobumps, verdict.decision);
    printImpact(impact);
    const deprecation = deprecationOf(candidate, meta);
    printDeprecation(deprecation);

    if (opts.apply) {
      try {
        await openPr(gh, ref, base, res, verdict, impact, deprecation, introduced, config.rebase);
      } catch (err) {
        log.error(`${candidate.name}: ${(err as Error).message}`);
      }
    }
  }

  // Lockfile refresh: regenerate lockfiles within existing ranges (routine
  // cadence). Opt-in; picks up in-range transitive fixes without overrides.
  if (config.lockRefresh.enabled && routineAllowed) {
    const maint = await lockRefresh(gh, ref, config, base);
    for (const m of maint) {
      const sec = m.securityFixed.length > 0 ? pc.red(` 🔒 fixes ${m.securityFixed.length}`) : "";
      process.stdout.write(
        `\n${pc.bold(`lockfile refresh: ${m.lockPath}`)} — ${m.changed.length} updated${sec} ${pc.dim(`(${m.ecosystem})`)}\n`,
      );
      // Never open a refresh PR that would pull in malware or a high/critical
      // vuln — a lockfile is atomic, so one bad new version blocks the refresh.
      if (m.blocked.length > 0) {
        for (const b of m.blocked) {
          process.stdout.write(`  ${pc.red("⛔ blocked")} — would introduce ${b.reason} \`${b.name}@${b.version}\` (${b.ids.slice(0, 2).join(", ")})\n`);
        }
        continue;
      }
      if (opts.apply) {
        try {
          await upsertPr(gh, ref, base, config.rebase, {
            branch: `converge/lock-refresh/${m.lockPath.replace(/[/.]/g, "-")}`,
            title: `Lockfile refresh (${m.lockPath})`,
            body: renderLockRefreshPrBody(m),
            files: m.files,
          });
        } catch (err) {
          log.error(`lockfile refresh ${m.lockPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  process.stdout.write("\n");
  log.info(
    `${resolved} resolved, ${blocked} blocked/held, ${unsolvable} unresolvable, ` +
      `${reportOnly} report-only` +
      (opts.apply ? "" : ` — re-run with ${pc.bold("--apply")} to open PRs`),
  );
  return 0;
}
