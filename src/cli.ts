#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./commands/scan.js";
import { setLogLevel } from "./logger.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("safebump")
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
