import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ResolvedFile } from "./types.js";
import { log } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface UvRefreshResult {
  ok: boolean;
  files: ResolvedFile[];
  stderr: string;
}

/**
 * Lock file refresh: `uv lock --upgrade` re-resolves every dependency to the
 * latest version allowed by pyproject.toml (pyproject is never modified),
 * writing only uv.lock. `--no-build` never executes a build backend.
 */
export async function updateUvLock(workdir: string): Promise<UvRefreshResult> {
  const args = ["lock", "--upgrade", "--no-build"];
  log.debug(`uv ${args.join(" ")} (cwd=${workdir})`);
  try {
    await execFileAsync("uv", args, { cwd: workdir, maxBuffer: 32 * 1024 * 1024 });
    const files: ResolvedFile[] = [];
    try {
      await access(path.join(workdir, "uv.lock"));
      files.push({ name: "uv.lock", content: await readFile(path.join(workdir, "uv.lock"), "utf8") });
    } catch {
      /* no uv.lock produced */
    }
    return { ok: true, files, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, files: [], stderr: (e.stderr ?? e.stdout ?? String(err)).trim() };
  }
}

export type UvFailureKind = "conflict" | "needs-build" | "error";

export interface UvResult {
  ok: boolean;
  status: "resolved" | UvFailureKind;
  /** Compiled, fully-pinned requirements (lockfile) when resolved. */
  lockfile?: string;
  /** Human-readable message (uv's explanation on failure). */
  message: string;
}

/** Classify a uv compile failure from its stderr. */
export function classifyUvFailure(stderr: string): UvFailureKind {
  if (/no usable wheels|building from source is disabled/i.test(stderr)) {
    return "needs-build";
  }
  if (/No solution found/i.test(stderr)) return "conflict";
  return "error";
}

/** Extract the core explanation block uv prints after "No solution found". */
export function extractUvExplanation(stderr: string): string {
  return stderr
    .split("\n")
    .map((l) => l.replace(/^\s*[│╰╭─×]+\s?/, "").trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .trim();
}

/**
 * Resolve a requirements file with uv, metadata-only and WITHOUT building or
 * executing any package code (`--no-build`). This is the pip analogue of npm's
 * `--package-lock-only`: it produces a fully-pinned lockfile or a precise
 * conflict explanation, with zero arbitrary code execution.
 */
export async function uvCompile(dir: string, inputFile: string): Promise<UvResult> {
  const outFile = path.join(dir, ".converge.lock");
  const args = [
    "pip",
    "compile",
    inputFile,
    "-o",
    outFile,
    "--no-header",
    "--no-build", // never execute setup.py / build backends
    "--no-annotate",
  ];
  log.debug(`uv ${args.join(" ")} (cwd=${dir})`);
  try {
    await execFileAsync("uv", args, { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
    const lockfile = await readFile(outFile, "utf8");
    return { ok: true, status: "resolved", lockfile, message: "resolved" };
  } catch (err) {
    const e = err as { stderr?: string; code?: string };
    if (e.code === "ENOENT") {
      return { ok: false, status: "error", message: "uv is not installed (see https://docs.astral.sh/uv/)" };
    }
    const stderr = e.stderr ?? String(err);
    const status = classifyUvFailure(stderr);
    return {
      ok: false,
      status,
      message: status === "conflict" ? extractUvExplanation(stderr) : stderr.trim(),
    };
  }
}

export interface UvLockResult {
  ok: boolean;
  message: string;
}

/**
 * Update uv.lock for a uv/PEP 621 project (`uv lock`) — resolves from metadata,
 * no build/code execution. Requires a `[project]` table (not Poetry-only).
 */
export async function uvLock(dir: string): Promise<UvLockResult> {
  log.debug(`uv lock (cwd=${dir})`);
  try {
    await execFileAsync("uv", ["lock"], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, message: "resolved" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    const out = (e.stderr ?? e.stdout ?? String(err)).trim();
    return { ok: false, message: out };
  }
}
