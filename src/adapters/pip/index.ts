import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  EcosystemAdapter,
  Manifest,
  PackageMeta,
  UpdateCandidate,
} from "../types.js";
import { parseRequirements } from "./requirements.js";
import { fetchPyPiMeta } from "./pypi.js";
import { log } from "../../logger.js";

/** Compare two PEP 440-ish versions via semver, tolerant of non-semver input. */
function classify(from: string, to: string): UpdateCandidate["updateType"] {
  const a = semver.coerce(from);
  const b = semver.coerce(to);
  if (!a || !b) return from === to ? "none" : "unknown";
  if (semver.eq(a, b)) return "none";
  if (semver.gt(a, b)) return "none"; // not an upgrade
  const diff = semver.diff(a, b);
  if (diff === "major" || diff === "premajor") return "major";
  if (diff === "minor" || diff === "preminor") return "minor";
  return "patch";
}

function isNewer(from: string, to: string): boolean {
  const a = semver.coerce(from);
  const b = semver.coerce(to);
  if (a && b) return semver.gt(b, a);
  return from !== to;
}

export class PipAdapter implements EcosystemAdapter {
  readonly id = "pip" as const;
  readonly manifestFilenames = ["requirements.txt"];

  async parseManifest(absPath: string, repoRoot: string): Promise<Manifest> {
    const raw = await readFile(absPath, "utf8");
    const deps = parseRequirements(raw);
    return {
      ecosystem: "pip",
      path: absPath,
      dir: path.relative(repoRoot, path.dirname(absPath)) || ".",
      dependencies: deps,
    };
  }

  async fetchPackageMeta(name: string): Promise<PackageMeta> {
    return fetchPyPiMeta(name);
  }

  async listOutdated(manifest: Manifest): Promise<UpdateCandidate[]> {
    const out: UpdateCandidate[] = [];
    const results = await Promise.allSettled(
      manifest.dependencies.map(async (dep) => {
        // First slice: only act on exact pins (==x) — the unambiguous,
        // actionable case (matches caseforge's langchain==1.0.8). Range floors
        // (>=) are surfaced later once we model installed versions.
        const pin = "pin" in dep ? (dep as { pin: string | null }).pin : null;
        if (!pin) {
          log.debug(`skip ${dep.name} (${dep.range || "no spec"}; not an == pin)`);
          return null;
        }
        const meta = await fetchPyPiMeta(dep.name);
        if (!meta.latest || !isNewer(pin, meta.latest)) return null;

        const candidate: UpdateCandidate = {
          ecosystem: "pip",
          manifestPath: manifest.path,
          dir: manifest.dir,
          name: dep.name,
          kind: dep.kind,
          currentRange: dep.range,
          currentVersion: pin,
          latestVersion: meta.latest,
          updateType: classify(pin, meta.latest),
        };
        return candidate;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) out.push(r.value);
      else if (r.status === "rejected") log.debug(`pypi meta failed: ${r.reason}`);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
