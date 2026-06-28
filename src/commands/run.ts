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
import type { SafetyVerdict } from "../safety/types.js";
import { fetchPackageMeta } from "../adapters/npm/registry.js";
import { log } from "../logger.js";

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

async function openPr(
  gh: GitHubClient,
  ref: RepoRef,
  base: string,
  res: CandidateResolution,
  safety: SafetyVerdict,
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
    body: renderPrBody(res.candidate, res.outcome, safety),
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

  let resolved = 0;
  let unsolvable = 0;
  let blocked = 0;
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

    const res = await resolveCandidate(gh, ref, base, candidate);
    printResolution(res);
    if (res.outcome.status === "unsolvable") {
      unsolvable++;
      continue;
    }
    resolved++;
    if (opts.apply) {
      try {
        await openPr(gh, ref, base, res, verdict);
      } catch (err) {
        log.error(`${candidate.name}: ${(err as Error).message}`);
      }
    }
  }

  process.stdout.write("\n");
  log.info(
    `${resolved} resolved, ${blocked} blocked/held, ${unsolvable} unresolvable` +
      (opts.apply ? "" : ` — re-run with ${pc.bold("--apply")} to open PRs`),
  );
  return 0;
}
