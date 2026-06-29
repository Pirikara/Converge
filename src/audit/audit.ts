import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { parseNpmLockTree, type LockPackage } from "./lockfile-npm.js";
import { queryOsvBatch, queryOsv, type OsvVuln } from "../safety/osv.js";

export interface AuditFinding {
  name: string;
  version: string;
  /** Declared in the manifest (vs only present transitively in the lockfile). */
  direct: boolean;
  vulns: OsvVuln[];
}

export interface AuditResult {
  ecosystem: string;
  lockfile: string;
  /** Total packages (direct + transitive) audited. */
  total: number;
  findings: AuditFinding[];
}

export interface AuditDeps {
  batch: (ecosystem: string, items: LockPackage[]) => Promise<string[][]>;
  query: (ecosystem: string, name: string, version: string) => Promise<OsvVuln[]>;
}

const defaultDeps: AuditDeps = { batch: queryOsvBatch, query: queryOsv };

/**
 * Audit a full set of resolved packages (direct + transitive) against OSV:
 * batch-query to find hits, then fetch full advisories only for those, so we
 * can classify malware vs vulnerability and severity.
 */
export async function auditPackages(
  ecosystem: string,
  tree: LockPackage[],
  directs: Set<string>,
  deps: AuditDeps = defaultDeps,
): Promise<AuditFinding[]> {
  const ids = await deps.batch(ecosystem, tree);
  const findings: AuditFinding[] = [];
  for (let i = 0; i < tree.length; i++) {
    if (!ids[i] || ids[i]!.length === 0) continue;
    const pkg = tree[i]!;
    const vulns = await deps.query(ecosystem, pkg.name, pkg.version);
    if (vulns.length > 0) {
      findings.push({ name: pkg.name, version: pkg.version, direct: directs.has(pkg.name), vulns });
    }
  }
  // Malware first, then by whether transitive, then name.
  findings.sort(
    (a, b) =>
      Number(b.vulns.some((v) => v.malware)) - Number(a.vulns.some((v) => v.malware)) ||
      a.name.localeCompare(b.name),
  );
  return findings;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Audit the npm lockfile tree in a directory (transitive deps included). */
export async function auditDir(dir: string): Promise<AuditResult | null> {
  const lockPath = path.join(dir, "package-lock.json");
  if (!(await exists(lockPath))) return null;

  const tree = parseNpmLockTree(await readFile(lockPath, "utf8"));
  const directs = new Set<string>();
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    for (const block of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const n of Object.keys(pkg[block] ?? {})) directs.add(n);
    }
  } catch {
    /* no package.json */
  }

  const findings = await auditPackages("npm", tree, directs);
  return { ecosystem: "npm", lockfile: "package-lock.json", total: tree.length, findings };
}
