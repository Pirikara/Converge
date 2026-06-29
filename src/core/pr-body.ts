import type { UpdateCandidate } from "../adapters/types.js";
import type { SafetyVerdict } from "../safety/types.js";
import type { ImpactReport } from "../impact/analyze.js";
import type { DeprecationFinding } from "../deprecation/detect.js";
import type { CandidateResolution } from "./apply.js";

// Project repo shown in the PR footer. Override via env when published.
const CONVERGE_URL = process.env.CONVERGE_PROJECT_URL ?? "https://github.com/converge/converge";

function registryLinks(c: UpdateCandidate): string {
  if (c.ecosystem === "pip") {
    const base = `https://pypi.org/project/${c.name}`;
    return `[PyPI](${base}/) · [${c.name} ${c.latestVersion}](${base}/${c.latestVersion}/)`;
  }
  const base = `https://www.npmjs.com/package/${c.name}`;
  return `[npm](${base}) · [${c.name}@${c.latestVersion}](${base}/v/${c.latestVersion})`;
}

function renderResolution(c: UpdateCandidate, res: CandidateResolution): string[] {
  const lines = ["### 🔧 Resolution (F1)"];
  const verified =
    c.ecosystem === "pip"
      ? "verified resolvable via uv (no package code executed)"
      : "lockfile regenerated (no package code executed)";
  const method =
    res.status === "resolved-cobump"
      ? `resolved via ${res.cobumps} co-bump${res.cobumps === 1 ? "" : "s"}`
      : "resolved directly";
  lines.push(`- ✅ ${method}; ${verified}`);
  lines.push("- changes:");
  for (const ch of res.changes) {
    const tag = ch.cobump ? " _(auto co-bump)_" : "";
    lines.push(`  - \`${ch.name}\`: \`${ch.fromRange}\` → \`${ch.toRange}\`${tag}`);
  }
  if (res.warnings.length > 0) {
    lines.push("- ⚠️ warnings:");
    for (const w of res.warnings) lines.push(`  - ${w}`);
  }
  return lines;
}

function renderDeprecation(findings: DeprecationFinding[]): string[] {
  const lines = ["### ⏳ Deprecation (F4)"];
  if (findings.length === 0) {
    lines.push("- ✅ not deprecated; actively maintained");
    return lines;
  }
  for (const f of findings) {
    const rep = f.replacement ? ` → consider **${f.replacement}**` : "";
    lines.push(`- ${f.severity === "warn" ? "⚠️" : "ℹ️"} ${f.detail}${rep}`);
  }
  return lines;
}

function renderImpact(impact: ImpactReport): string[] {
  const { usage, risk } = impact;
  const lines = ["### 📋 Impact (F3)", `- **Risk: ${risk.risk}** — ${risk.reasons.join("; ")}`];
  if (usage.files === 0) {
    lines.push(`- \`${usage.pkg}\` is not imported directly in this repo`);
    return lines;
  }
  lines.push(`- used in **${usage.files} file(s)**, ${usage.sites.length} import site(s):`);
  for (const s of usage.sites.slice(0, 10)) {
    const syms = s.symbols.length ? ` — \`${s.symbols.join(", ")}\`` : "";
    lines.push(`  - \`${s.file}:${s.line}\` (${s.kind})${syms}`);
  }
  if (usage.sites.length > 10) lines.push(`  - …and ${usage.sites.length - 10} more`);
  return lines;
}

function renderSafety(verdict: SafetyVerdict): string[] {
  const lines = ["### ✅ Safety (F2)"];
  if (verdict.signals.length === 0) {
    lines.push("- ✅ no known OSV advisories; cooldown passed");
    return lines;
  }
  const badge =
    verdict.decision === "warn" ? "⚠️ proceeding with warnings" : `decision: **${verdict.decision}**`;
  lines.push(`- ${badge}`);
  for (const s of verdict.signals) {
    const ref = s.url ? ` ([${s.id}](${s.url}))` : "";
    lines.push(`  - \`${s.kind}\` (${s.severity}): ${s.detail}${ref}`);
  }
  return lines;
}

/**
 * Render the PR body: resolution (F1, incl. auto co-bumps) + safety (F2) +
 * impact (F3) + deprecation (F4). Ecosystem-aware; never overclaims.
 */
export function renderPrBody(
  c: UpdateCandidate,
  res: CandidateResolution,
  safety: SafetyVerdict,
  impact: ImpactReport,
  deprecation: DeprecationFinding[],
): string {
  const from = c.currentVersion ?? c.currentRange;
  const lines = [
    `## Converge: ${c.name} ${from} → ${c.latestVersion}  ·  Risk: ${impact.risk.risk}`,
    "",
    ...renderResolution(c, res),
    "",
    ...renderSafety(safety),
    "",
    ...renderImpact(impact),
    "",
    ...renderDeprecation(deprecation),
    "",
    "### Links",
    `- ${registryLinks(c)}`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ];
  return lines.join("\n");
}

/** PR title, including a co-bump count when applicable. */
export function renderPrTitle(c: UpdateCandidate, res: CandidateResolution): string {
  const from = c.currentVersion ?? c.currentRange;
  const base = `bump ${c.name} from ${from} to ${c.latestVersion}`;
  if (res.status === "resolved-cobump" && res.cobumps > 0) {
    return `${base} (+${res.cobumps} co-bump${res.cobumps === 1 ? "" : "s"})`;
  }
  return base;
}
