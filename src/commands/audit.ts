import path from "node:path";
import pc from "picocolors";
import { auditDir, type AuditFinding } from "../audit/audit.js";
import { log } from "../logger.js";

export interface AuditOptions {
  json?: boolean;
}

function sevColor(s: string): (t: string) => string {
  if (s === "critical" || s === "high") return pc.red;
  if (s === "moderate") return pc.yellow;
  return pc.dim;
}

function printFinding(f: AuditFinding): void {
  const scope = f.direct ? pc.dim("direct") : pc.magenta("transitive");
  const malware = f.vulns.some((v) => v.malware);
  const head = malware ? pc.red(pc.bold("MALWARE")) : "vuln";
  process.stdout.write(
    `\n  ${head}  ${pc.bold(`${f.name}@${f.version}`)}  ${pc.dim(`[${f.ecosystem}]`)} [${scope}]\n`,
  );
  for (const v of f.vulns.slice(0, 4)) {
    const tag = v.malware ? pc.red("malware") : sevColor(v.severity)(v.severity);
    process.stdout.write(`    - [${tag}] ${v.id}${v.summary ? ` — ${v.summary}` : ""}\n`);
  }
}

export async function runAudit(dir: string, opts: AuditOptions): Promise<number> {
  const repoDir = path.resolve(dir);
  const result = await auditDir(repoDir);
  if (!result) {
    log.error(`no lockfile found in ${repoDir} (looked for package-lock.json / pnpm-lock.yaml / yarn.lock / Gemfile.lock / go.sum)`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  log.info(
    `audited ${pc.bold(String(result.total))} packages (direct + transitive) from ${result.lockfiles.join(", ")}`,
  );

  if (result.findings.length === 0) {
    log.info(pc.green("no known malware or vulnerabilities in the dependency tree ✓"));
    return 0;
  }

  const malware = result.findings.filter((f) => f.vulns.some((v) => v.malware));
  const transitive = result.findings.filter((f) => !f.direct);
  for (const f of result.findings) printFinding(f);

  process.stdout.write("\n");
  log.warn(
    `${result.findings.length} affected package(s): ` +
      `${malware.length} malware, ${transitive.length} transitive ` +
      `(${transitive.length} would be missed by direct-only scanners)`,
  );
  return malware.length > 0 ? 2 : 0;
}
