import pc from "picocolors";
import {
  GitHubClient,
  parseRepoRef,
  resolveToken,
  type RepoRef,
} from "../github/client.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import { stripJsonComments } from "../config/load.js";
import { selectCandidates, branchName, type UpdateType } from "../core/plan.js";
import { resolveCandidate, type CandidateResolution } from "../core/apply.js";
import { renderPrBody, renderPrTitle } from "../core/pr-body.js";
import { evaluateSafety } from "../safety/gate.js";
import { provenanceStatus } from "../safety/provenance.js";
import type { SafetyVerdict } from "../safety/types.js";
import { analyzeImpact, type ImpactReport } from "../impact/analyze.js";
import { isSourceFile, type SourceFile } from "../impact/usage.js";
import { detectDeprecation, type DeprecationFinding } from "../deprecation/detect.js";
import {
  decidePackageManager,
  isResolvable,
  type NpmPackageManager,
} from "../resolve/pm-detect.js";
import { fetchPackageMeta } from "../adapters/npm/registry.js";
import { log } from "../logger.js";

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
  const file = await gh.getFile(ref, "safebump.json", base);
  if (!file) return ConfigSchema.parse({});
  return ConfigSchema.parse(JSON.parse(stripJsonComments(file.content)));
}

function printResolution(res: CandidateResolution): void {
  if (res.outcome.status === "unsolvable") {
    process.stdout.write(`  ${pc.red("✗ unresolvable")} — ${res.outcome.reason}\n`);
    return;
  }
  const tag =
    res.outcome.status === "resolved-cobump"
      ? pc.yellow(`co-bump×${res.outcome.changes.length - 1}`)
      : pc.green("direct");
  process.stdout.write(`  ${pc.green("✓ resolved")} (${tag})\n`);
  for (const ch of res.outcome.changes) {
    const mark = ch.cobump ? pc.yellow("  + ") : "  • ";
    process.stdout.write(`${mark}${ch.name}: ${ch.fromRange} → ${ch.toRange}\n`);
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

async function openPr(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  res: CandidateResolution,
  safety: SafetyVerdict,
  impact: ImpactReport,
  deprecation: DeprecationFinding[],
): Promise<void> {
  const branch = branchName(res.candidate);
  if (await gh.branchExists(ref, branch)) {
    const existing = await gh.findOpenPr(ref, branch);
    process.stdout.write(
      `  ${existing ? `exists → PR #${existing}` : "branch exists"} ${pc.dim("(skipped)")}\n`,
    );
    return;
  }
  const baseSha = await gh.getBranchSha(ref, base);
  const title = renderPrTitle(res.candidate, res.outcome);
  await gh.commitFiles(ref, { branch, baseSha, message: title, files: res.repoFiles });
  const pr = await gh.createPr(ref, {
    head: branch,
    base,
    title,
    body: renderPrBody(res.candidate, res.outcome, safety, impact, deprecation),
  });
  process.stdout.write(`  ${pc.green("created")} PR #${pr.number} → ${pr.url}\n`);
}

export async function runRun(repoInput: string, opts: RunOptions): Promise<number> {
  const ref = parseRepoRef(repoInput);
  const gh = new GitHubClient(resolveToken(opts.token));

  const base = await gh.getDefaultBranch(ref);
  const config = await loadRepoConfig(gh, ref, base);
  const allow = parseTypes(opts.types);
  const limit = Math.max(1, Number(opts.limit ?? "5") || 5);

  log.info(
    `${ref.owner}/${ref.repo} — proposing [${allow.join(", ")}] updates ` +
      `(limit ${limit}, ${opts.apply ? pc.red("APPLY") : pc.cyan("dry-run")})`,
  );

  const { selected } = await selectCandidates(gh, ref, config, { allow, limit });
  if (selected.length === 0) {
    log.info(pc.green("no eligible updates ✓"));
    return 0;
  }

  const sourceCache = new Map<string, SourceFile[]>();
  const getSources = async (dir: string): Promise<SourceFile[]> => {
    const cached = sourceCache.get(dir);
    if (cached) return cached;
    const files = await gh.fetchSourceFiles(ref, base, {
      dirPrefix: dir,
      predicate: isSourceFile,
      cap: SOURCE_FILE_CAP,
    });
    sourceCache.set(dir, files);
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
  for (const candidate of selected) {
    const header =
      `\n${pc.bold(candidate.name)} ${pc.dim(candidate.currentVersion ?? candidate.currentRange)} → ` +
      `${pc.bold(candidate.latestVersion)} [${candidate.updateType}] ${pc.dim(`(${candidate.dir})`)}`;
    process.stdout.write(`${header}\n`);

    // F2 gate first: never resolve/install a dangerous or held version.
    const meta = await fetchPackageMeta(candidate.name);
    const verdict = await evaluateSafety(
      {
        ecosystem: "npm",
        name: candidate.name,
        version: candidate.latestVersion,
        publishedAt: meta.publishedAt[candidate.latestVersion],
        provenance: provenanceStatus(meta, candidate.currentVersion, candidate.latestVersion),
      },
      config.safety,
    );
    printSafety(verdict);
    if (verdict.decision === "block" || verdict.decision === "hold") {
      blocked++;
      process.stdout.write(
        `  ${pc.red("⛔ skipped")} — ${verdict.decision === "block" ? "unsafe target" : "within cooldown"}\n`,
      );
      continue;
    }

    // Guard: only resolve managers we can safely regenerate a lockfile for.
    const pm = await getPm(candidate.dir);
    if (!isResolvable(pm)) {
      process.stdout.write(`  ${pc.dim(`pm: ${pm}`)}\n`);
      const impact = analyzeImpact(candidate, await getSources(candidate.dir), 0, verdict.decision);
      printImpact(impact);
      printDeprecation(
        detectDeprecation(
          { name: candidate.name, currentVersion: candidate.currentVersion, targetVersion: candidate.latestVersion },
          meta,
          { staleDays: STALE_DAYS, now: Date.now() },
        ),
      );
      process.stdout.write(
        `  ${pc.yellow("⊘ resolution skipped")} — ${pm} lockfiles not yet supported (report only, no PR)\n`,
      );
      reportOnly++;
      continue;
    }

    const res = await resolveCandidate(gh, ref, base, candidate);
    printResolution(res);
    if (res.outcome.status === "unsolvable") {
      unsolvable++;
      continue;
    }
    resolved++;

    // F3 impact: usage mapping + risk over the consuming repo's source.
    const cobumps =
      res.outcome.status === "resolved-cobump"
        ? res.outcome.changes.filter((c) => c.cobump).length
        : 0;
    const impact = analyzeImpact(candidate, await getSources(candidate.dir), cobumps, verdict.decision);
    printImpact(impact);

    // F4 deprecation/abandonment (from the registry metadata already fetched).
    const deprecation = detectDeprecation(
      { name: candidate.name, currentVersion: candidate.currentVersion, targetVersion: candidate.latestVersion },
      meta,
      { staleDays: STALE_DAYS, now: Date.now() },
    );
    printDeprecation(deprecation);

    if (opts.apply) {
      try {
        await openPr(gh, ref, base, res, verdict, impact, deprecation);
      } catch (err) {
        log.error(`${candidate.name}: ${(err as Error).message}`);
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
