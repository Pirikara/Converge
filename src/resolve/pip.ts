import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { editRequirementPin } from "../adapters/pip/requirements.js";
import { uvCompile } from "./uv-cli.js";
import type { PackageChange } from "./types.js";

export interface PipResolveOutcome {
  status: "resolved" | "unsolvable" | "needs-build";
  changes: PackageChange[];
  /** Fully-pinned lockfile when resolved. */
  lockfile?: string;
  /** uv's explanation on conflict / needs-build. */
  reason?: string;
}

export interface PipResolveRequest {
  workdir: string;
  requirementsFile: string;
  name: string;
  fromPin: string;
  toVersion: string;
}

/**
 * Resolve a single pip `==` pin bump using uv (metadata-only, no code executed).
 * First slice: direct bump → re-resolve. Either the new pin set resolves
 * cleanly (lockfile returned), or we surface uv's exact conflict / a
 * needs-build outcome for source-only packages. Co-bump is a follow-up.
 */
export async function resolvePipUpdate(req: PipResolveRequest): Promise<PipResolveOutcome> {
  const reqPath = path.join(req.workdir, req.requirementsFile);
  const original = await readFile(reqPath, "utf8");
  const edited = editRequirementPin(original, req.name, req.fromPin, req.toVersion);
  await writeFile(reqPath, edited);

  const change: PackageChange = {
    name: req.name,
    fromRange: `==${req.fromPin}`,
    toRange: `==${req.toVersion}`,
    cobump: false,
  };

  const result = await uvCompile(req.workdir, req.requirementsFile);
  switch (result.status) {
    case "resolved":
      return { status: "resolved", changes: [change], lockfile: result.lockfile };
    case "needs-build":
      return { status: "needs-build", changes: [change], reason: result.message };
    default:
      return { status: "unsolvable", changes: [change], reason: result.message };
  }
}
