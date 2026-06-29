#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./commands/scan.js";
import { runRun } from "./commands/run.js";
import { runResolve } from "./commands/resolve.js";
import { setLogLevel } from "./logger.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("converge")
  .description(
    "Safe, hands-off dependency updates. Resolves what Dependabot can't, blocks what you shouldn't install.",
  )
  .version(version)
  .option("-v, --verbose", "enable debug logging", false);

program
  .command("scan")
  .description("List outdated dependencies for a repository")
  .argument("[dir]", "path to the repository root", ".")
  .option("--json", "output machine-readable JSON", false)
  .action(async (dir: string, opts: { json: boolean }) => {
    if (program.opts().verbose) setLogLevel("debug");
    const code = await runScan(dir, { json: opts.json });
    process.exitCode = code;
  });

program
  .command("run")
  .description("Plan and (with --apply) open update PRs for a GitHub repository")
  .argument("<repo>", "target repository as owner/repo or GitHub URL")
  .option("--apply", "actually create branches and PRs (default: dry-run)", false)
  .option("--token <token>", "GitHub token (else CONVERGE_TOKEN / GITHUB_TOKEN)")
  .option("--types <list>", "comma-separated bump types to allow", "minor,patch")
  .option("--limit <n>", "max PRs to plan in one run", "5")
  .action(async (repo: string, opts: Record<string, string | boolean>) => {
    if (program.opts().verbose) setLogLevel("debug");
    const code = await runRun(repo, {
      apply: opts.apply as boolean,
      token: opts.token as string | undefined,
      types: opts.types as string,
      limit: opts.limit as string,
    });
    process.exitCode = code;
  });

program
  .command("resolve")
  .description("Resolve a single dependency bump (regenerates lockfile, no code run)")
  .argument("<dir>", "path to the package.json directory")
  .argument("<pkg>", "dependency name to update")
  .argument("<version>", "target version (e.g. 19.0.0)")
  .option("--write", "write updated package.json + lockfile back to dir", false)
  .action(async (dir: string, pkg: string, version: string, opts: { write: boolean }) => {
    if (program.opts().verbose) setLogLevel("debug");
    const code = await runResolve(dir, pkg, version, { write: opts.write });
    process.exitCode = code;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
