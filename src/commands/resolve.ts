import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { bumpRange } from "../adapters/npm/range.js";
import { resolveUpdate } from "../resolve/ladder.js";
import { prepareWorkdir, cleanupWorkdir } from "../resolve/workdir.js";
import { log } from "../logger.js";

export interface ResolveOptions {
  write?: boolean;
}

function currentRange(pkgJson: string, name: string): string | null {
  const obj = JSON.parse(pkgJson) as Record<string, Record<string, string>>;
  for (const b of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (obj[b]?.[name]) return obj[b]![name]!;
  }
  return null;
}

export async function runResolve(
  dir: string,
  pkg: string,
  toVersion: string,
  opts: ResolveOptions,
): Promise<number> {
  const repoDir = path.resolve(dir);
  const pkgPath = path.join(repoDir, "package.json");
  const manifest = await readFile(pkgPath, "utf8");
  const fromRange = currentRange(manifest, pkg);
  if (!fromRange) {
    log.error(`${pkg} is not a dependency in ${pkgPath}`);
    return 1;
  }
  const toRange = bumpRange(fromRange, toVersion);

  log.info(
    `resolving ${pc.bold(pkg)} ${fromRange} → ${toRange} ${pc.dim("(no code executed)")}`,
  );

  const workdir = await prepareWorkdir(repoDir);
  try {
    const outcome = await resolveUpdate({ workdir, name: pkg, fromRange, toRange });

    if (outcome.status === "unsolvable") {
      process.stdout.write(`\n${pc.red("✗ unresolvable")} — ${outcome.reason}\n`);
      process.stdout.write(`  attempted: ${outcome.attempted.join(" → ")}\n`);
      if (outcome.rawError) {
        process.stdout.write(
          pc.dim(outcome.rawError.split("\n").map((l) => `  │ ${l}`).join("\n")) + "\n",
        );
      }
      return 2;
    }

    const tag = outcome.status === "resolved-cobump" ? pc.yellow("via co-bump") : pc.green("direct");
    process.stdout.write(`\n${pc.green("✓ resolved")} (${tag})\n`);
    for (const c of outcome.changes) {
      const mark = c.cobump ? pc.yellow("  + co-bump ") : "  • ";
      process.stdout.write(`${mark}${c.name}: ${c.fromRange} → ${c.toRange}\n`);
    }

    if (opts.write) {
      for (const f of outcome.files) {
        await writeFile(path.join(repoDir, f.name), f.content);
      }
      process.stdout.write(
        `\n${pc.cyan("wrote")} ${outcome.files.map((f) => f.name).join(", ")} to ${repoDir}\n`,
      );
    } else {
      process.stdout.write(
        `\n${pc.dim("dry-run — pass")} --write ${pc.dim("to update package.json + lockfile")}\n`,
      );
    }
    return 0;
  } finally {
    await cleanupWorkdir(workdir);
  }
}
