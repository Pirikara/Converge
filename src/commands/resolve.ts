import { readFile, writeFile, access, mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pc from "picocolors";
import { bumpRange } from "../adapters/npm/range.js";
import { parseRequirements } from "../adapters/pip/requirements.js";
import { parseGemfile, editGemfilePin } from "../adapters/rubygems/gemfile.js";
import { getResolver } from "../resolve/npm-family.js";
import { decidePackageManager } from "../resolve/pm-detect.js";
import { resolvePipUpdate } from "../resolve/pip.js";
import { resolveBundleLock } from "../resolve/ruby-cli.js";
import { prepareWorkdir, cleanupWorkdir } from "../resolve/workdir.js";
import { log } from "../logger.js";

const NPM_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

export interface ResolveOptions {
  write?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function currentRange(pkgJson: string, name: string): string | null {
  const obj = JSON.parse(pkgJson) as Record<string, Record<string, string>>;
  for (const b of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (obj[b]?.[name]) return obj[b]![name]!;
  }
  return null;
}

async function detectLocalPm(repoDir: string): Promise<ReturnType<typeof decidePackageManager>> {
  let packageManagerField: string | null = null;
  try {
    packageManagerField =
      (JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as {
        packageManager?: string;
      }).packageManager ?? null;
  } catch {
    /* ignore */
  }
  const lockfiles: string[] = [];
  for (const lf of NPM_LOCKFILES) {
    if (await exists(path.join(repoDir, lf))) lockfiles.push(lf);
  }
  return decidePackageManager({ packageManagerField, lockfiles });
}

async function runResolveNpm(
  repoDir: string,
  pkg: string,
  toVersion: string,
  opts: ResolveOptions,
): Promise<number> {
  const manifest = await readFile(path.join(repoDir, "package.json"), "utf8");
  const fromRange = currentRange(manifest, pkg);
  if (!fromRange) {
    log.error(`${pkg} is not a dependency in package.json`);
    return 1;
  }
  const pm = await detectLocalPm(repoDir);
  const resolver = getResolver(pm);
  if (!resolver) {
    log.error(`package manager '${pm}' is not yet supported for resolution`);
    return 1;
  }
  const toRange = bumpRange(fromRange, toVersion);
  log.info(`resolving ${pc.bold(pkg)} ${fromRange} → ${toRange} ${pc.dim(`(${pm}, no code executed)`)}`);

  const workdir = await prepareWorkdir(repoDir);
  try {
    const r = await resolver.resolve({ workdir, name: pkg, fromRange, toRange });
    if (r.status === "unsolvable") {
      process.stdout.write(`\n${pc.red("✗ unresolvable")} — ${r.reason}\n`);
      return 2;
    }
    const tag = r.status === "resolved-cobump" ? pc.yellow("via co-bump") : pc.green("direct");
    process.stdout.write(`\n${pc.green("✓ resolved")} (${tag})\n`);
    for (const c of r.changes) {
      process.stdout.write(`${c.cobump ? pc.yellow("  + ") : "  • "}${c.name}: ${c.fromRange} → ${c.toRange}\n`);
    }
    for (const w of r.warnings) process.stdout.write(`  ${pc.yellow(`⚠ ${w}`)}\n`);
    if (opts.write) {
      for (const f of r.files) await writeFile(path.join(repoDir, f.name), f.content);
      process.stdout.write(`\n${pc.cyan("wrote")} ${r.files.map((f) => f.name).join(", ")}\n`);
    }
    return 0;
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function runResolvePip(
  repoDir: string,
  pkg: string,
  toVersion: string,
  opts: ResolveOptions,
): Promise<number> {
  const file = "requirements.txt";
  const content = await readFile(path.join(repoDir, file), "utf8");
  const dep = parseRequirements(content).find((d) => d.name === pkg);
  if (!dep) {
    log.error(`${pkg} is not in requirements.txt`);
    return 1;
  }
  if (!dep.pin) {
    log.error(`${pkg} is not an == pin (got "${dep.range}"); only exact pins are supported for now`);
    return 1;
  }
  log.info(`resolving ${pc.bold(pkg)} ==${dep.pin} → ==${toVersion} ${pc.dim("(pip/uv, no code executed)")}`);

  const workdir = await mkdtemp(path.join(tmpdir(), "converge-pip-"));
  try {
    await copyFile(path.join(repoDir, file), path.join(workdir, file));
    const outcome = await resolvePipUpdate({
      workdir,
      requirementsFile: file,
      name: pkg,
      fromPin: dep.pin,
      toVersion,
    });

    if (outcome.status === "needs-build") {
      process.stdout.write(`\n${pc.yellow("⚠ needs build")} — a dependency is source-only (no wheel);\n`);
      process.stdout.write(`  cannot verify without executing package code. Skipped by policy.\n`);
      return 3;
    }
    if (outcome.status === "unsolvable") {
      process.stdout.write(`\n${pc.red("✗ unresolvable")}\n`);
      process.stdout.write(pc.dim(outcome.reason?.split("\n").map((l) => `  │ ${l}`).join("\n") ?? "") + "\n");
      return 2;
    }
    const pins = (outcome.lockfile ?? "").split("\n").filter((l) => /^[A-Za-z0-9].*==/.test(l)).length;
    process.stdout.write(`\n${pc.green("✓ resolved")} (${pc.green("direct")}); ${pins} pins, no code executed\n`);
    for (const c of outcome.changes) process.stdout.write(`  • ${c.name}: ${c.fromRange} → ${c.toRange}\n`);
    if (opts.write) {
      await writeFile(path.join(repoDir, file), await readFile(path.join(workdir, file), "utf8"));
      process.stdout.write(`\n${pc.cyan("wrote")} ${file}\n`);
    }
    return 0;
  } finally {
    await cleanupWorkdir(workdir);
  }
}

async function runResolveRuby(
  repoDir: string,
  pkg: string,
  toVersion: string,
  opts: ResolveOptions,
): Promise<number> {
  const content = await readFile(path.join(repoDir, "Gemfile"), "utf8");
  const dep = parseGemfile(content).find((d) => d.name === pkg);
  if (!dep) {
    log.error(`${pkg} is not in the Gemfile`);
    return 1;
  }
  if (!dep.pin) {
    log.error(`${pkg} is not an exact pin (got "${dep.range}"); only exact pins are supported`);
    return 1;
  }
  log.info(`resolving ${pc.bold(pkg)} ${dep.pin} → ${toVersion} ${pc.dim("(rubygems/bundler, no gem code executed)")}`);

  const workdir = await mkdtemp(path.join(tmpdir(), "converge-ruby-"));
  try {
    await writeFile(path.join(workdir, "Gemfile"), editGemfilePin(content, pkg, dep.pin, toVersion));
    if (await exists(path.join(repoDir, "Gemfile.lock"))) {
      await copyFile(path.join(repoDir, "Gemfile.lock"), path.join(workdir, "Gemfile.lock"));
    }
    const r = await resolveBundleLock(workdir);
    if (!r.ok) {
      process.stdout.write(`\n${pc.red("✗ unresolvable")}\n${pc.dim(r.stderr)}\n`);
      return 2;
    }
    process.stdout.write(`\n${pc.green("✓ resolved")} (${pc.green("direct")})\n  • ${pkg}: ${dep.pin} → ${toVersion}\n`);
    if (opts.write) {
      for (const f of r.files) await writeFile(path.join(repoDir, f.name), f.content);
      process.stdout.write(`\n${pc.cyan("wrote")} ${r.files.map((f) => f.name).join(", ")}\n`);
    }
    return 0;
  } finally {
    await cleanupWorkdir(workdir);
  }
}

export async function runResolve(
  dir: string,
  pkg: string,
  toVersion: string,
  opts: ResolveOptions,
): Promise<number> {
  const repoDir = path.resolve(dir);
  if (await exists(path.join(repoDir, "package.json"))) {
    return runResolveNpm(repoDir, pkg, toVersion, opts);
  }
  if (await exists(path.join(repoDir, "requirements.txt"))) {
    return runResolvePip(repoDir, pkg, toVersion, opts);
  }
  if (await exists(path.join(repoDir, "Gemfile"))) {
    return runResolveRuby(repoDir, pkg, toVersion, opts);
  }
  log.error(`no package.json, requirements.txt, or Gemfile found in ${repoDir}`);
  return 1;
}
