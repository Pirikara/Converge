import pc from "picocolors";
import {
  GitHubClient,
  parseRepoRef,
  resolveToken,
} from "../github/client.js";
import { loadConfig } from "../config/load.js";
import { planUpdates, type UpdatePlan, type UpdateType } from "../core/plan.js";
import { log } from "../logger.js";

export interface RunOptions {
  apply?: boolean;
  token?: string;
  types?: string;
  limit?: string;
  configDir?: string;
}

const VALID_TYPES: UpdateType[] = ["major", "minor", "patch"];

function parseTypes(input: string | undefined): UpdateType[] {
  if (!input) return ["minor", "patch"];
  const parts = input.split(",").map((s) => s.trim());
  const types = parts.filter((t): t is UpdateType =>
    VALID_TYPES.includes(t as UpdateType),
  );
  return types.length > 0 ? types : ["minor", "patch"];
}

async function applyPlan(
  gh: GitHubClient,
  ref: ReturnType<typeof parseRepoRef>,
  base: string,
  plan: UpdatePlan,
): Promise<string> {
  if (await gh.branchExists(ref, plan.branch)) {
    const existing = await gh.findOpenPr(ref, plan.branch);
    return existing
      ? `exists → PR #${existing} (skipped)`
      : `branch exists, no open PR (skipped)`;
  }
  const baseSha = await gh.getBranchSha(ref, base);
  await gh.createBranch(ref, plan.branch, baseSha);
  await gh.putFile(ref, {
    path: plan.manifestPath,
    content: plan.newContent,
    branch: plan.branch,
    message: plan.title,
    sha: plan.fileSha,
  });
  const pr = await gh.createPr(ref, {
    head: plan.branch,
    base,
    title: plan.title,
    body: plan.body,
  });
  return `${pc.green("created")} PR #${pr.number} → ${pr.url}`;
}

export async function runRun(
  repoInput: string,
  opts: RunOptions,
): Promise<number> {
  const ref = parseRepoRef(repoInput);
  const token = resolveToken(opts.token);
  const gh = new GitHubClient(token);

  // Repo-side config is fetched from the default branch; fall back to defaults.
  const base = await gh.getDefaultBranch(ref);
  const cfgFile = await gh.getFile(ref, "safebump.json", base);
  const { config } = cfgFile
    ? await loadConfigFromString(cfgFile.content)
    : { config: (await loadConfig(process.cwd())).config };

  const allow = parseTypes(opts.types);
  const limit = Math.max(1, Number(opts.limit ?? "5") || 5);

  log.info(
    `${ref.owner}/${ref.repo} — proposing [${allow.join(", ")}] updates ` +
      `(limit ${limit}, ${opts.apply ? pc.red("APPLY") : pc.cyan("dry-run")})`,
  );

  const { plans } = await planUpdates(gh, ref, config, { allow, limit });

  if (plans.length === 0) {
    log.info(pc.green("no eligible updates ✓"));
    return 0;
  }

  for (const plan of plans) {
    const c = plan.candidate;
    const header =
      `${pc.bold(c.name)} ` +
      `${pc.dim(c.currentVersion ?? c.currentRange)} → ${pc.bold(c.latestVersion)} ` +
      `[${c.updateType}] ${pc.dim(`(${plan.manifestPath})`)}`;
    if (!opts.apply) {
      process.stdout.write(
        `\n${header}\n  branch: ${plan.branch}\n  ${pc.dim("would create PR:")} ${plan.title}\n`,
      );
      continue;
    }
    try {
      const result = await applyPlan(gh, ref, base, plan);
      process.stdout.write(`\n${header}\n  ${result}\n`);
    } catch (err) {
      log.error(`${c.name}: ${(err as Error).message}`);
    }
  }
  process.stdout.write("\n");

  if (!opts.apply) {
    log.info(
      `${plans.length} update(s) planned. Re-run with ${pc.bold("--apply")} to open PRs.`,
    );
  }
  return 0;
}

// Small helper: parse config from a string via the existing loader's schema.
async function loadConfigFromString(
  content: string,
): Promise<{ config: Awaited<ReturnType<typeof loadConfig>>["config"] }> {
  const { stripJsonComments } = await import("../config/load.js");
  const { ConfigSchema } = await import("../config/schema.js");
  const parsed = ConfigSchema.parse(JSON.parse(stripJsonComments(content)));
  return { config: parsed };
}
