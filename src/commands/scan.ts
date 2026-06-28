import pc from "picocolors";
import { scan } from "../core/scan.js";
import type { UpdateCandidate } from "../adapters/types.js";
import { log } from "../logger.js";

export interface ScanOptions {
  json?: boolean;
}

function colorType(t: UpdateCandidate["updateType"]): string {
  switch (t) {
    case "major":
      return pc.red(t);
    case "minor":
      return pc.yellow(t);
    case "patch":
      return pc.green(t);
    default:
      return pc.dim(t);
  }
}

export async function runScan(dir: string, opts: ScanOptions): Promise<number> {
  const result = await scan(dir);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  log.info(
    `scanned ${pc.bold(result.repoRoot)} ` +
      `(config: ${result.configSource ? "found" : "defaults"})`,
  );
  log.info(
    `${result.manifests.length} manifest(s), ` +
      `${result.candidates.length} outdated dependenc${
        result.candidates.length === 1 ? "y" : "ies"
      }`,
  );

  if (result.candidates.length === 0) {
    log.info(pc.green("everything up to date ✓"));
    return 0;
  }

  const byDir = new Map<string, UpdateCandidate[]>();
  for (const c of result.candidates) {
    const list = byDir.get(c.dir) ?? [];
    list.push(c);
    byDir.set(c.dir, list);
  }

  for (const [dir, list] of [...byDir].sort()) {
    process.stdout.write(`\n${pc.bold(pc.underline(dir))}\n`);
    const nameW = Math.max(...list.map((c) => c.name.length), 4);
    for (const c of list) {
      const from = c.currentVersion ?? c.currentRange;
      process.stdout.write(
        `  ${c.name.padEnd(nameW)}  ` +
          `${pc.dim(from)} ${pc.dim("→")} ${pc.bold(c.latestVersion)}  ` +
          `[${colorType(c.updateType)}] ${pc.dim(c.kind)}\n`,
      );
    }
  }
  process.stdout.write("\n");
  return 0;
}
