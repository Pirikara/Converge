import path from "node:path";
import { type LockPackage } from "./lockfile-npm.js";
import { enumerateLocks } from "./lockfiles.js";
import { queryOsvBatch, queryOsv, type OsvVuln } from "../safety/osv.js";

export interface AuditFinding {
  ecosystem: string;
  name: string;
  version: string;
  /** Declared in the manifest (vs only present transitively in the lockfile). */
  direct: boolean;
  vulns: OsvVuln[];
}

export interface AuditResult {
  /** Lockfiles audited (one per ecosystem present). */
  lockfiles: string[];
  /** Total packages (direct + transitive) audited across all lockfiles. */
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
      findings.push({ ecosystem, name: pkg.name, version: pkg.version, direct: directs.has(pkg.name), vulns });
    }
  }
  return findings;
}

function malwareFirst(a: AuditFinding, b: AuditFinding): number {
  return (
    Number(b.vulns.some((v) => v.malware)) - Number(a.vulns.some((v) => v.malware)) ||
    a.ecosystem.localeCompare(b.ecosystem) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Audit every lockfile tree in a directory (npm/pnpm/yarn, Gemfile.lock, go.sum)
 * — direct + transitive — against OSV.
 */
export async function auditDir(dir: string): Promise<AuditResult | null> {
  const locks = await enumerateLocks(path.resolve(dir));
  if (locks.length === 0) return null;

  let total = 0;
  const lockfiles: string[] = [];
  const findings: AuditFinding[] = [];
  for (const lk of locks) {
    total += lk.packages.length;
    lockfiles.push(lk.file);
    findings.push(...(await auditPackages(lk.ecosystem, lk.packages, lk.directs)));
  }
  findings.sort(malwareFirst);
  return { lockfiles, total, findings };
}
