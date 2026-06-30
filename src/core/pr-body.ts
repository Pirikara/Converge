import type { UpdateCandidate } from "../adapters/types.js";
import type { SafetyVerdict } from "../safety/types.js";
import type { ImpactReport } from "../impact/analyze.js";
import type { DeprecationFinding } from "../deprecation/detect.js";
import type { CandidateResolution } from "./apply.js";
import type { AuditFinding } from "../audit/audit.js";

function renderIntroduced(introduced: AuditFinding[]): string[] {
  const lines = ["### 🌳 Transitive impact (F2)"];
  if (introduced.length === 0) {
    lines.push("- ✅ introduces no transitive packages with known malware/vulnerabilities");
    return lines;
  }
  lines.push(`- ⚠️ this update pulls in **${introduced.length}** risky transitive package(s):`);
  for (const f of introduced) {
    const mal = f.vulns.some((v) => v.malware);
    const top = f.vulns[0]!;
    lines.push(
      `  - ${mal ? "**MALWARE**" : top.severity} \`${f.name}@${f.version}\` — ${top.id}` +
        (top.summary ? `: ${top.summary}` : ""),
    );
  }
  return lines;
}

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
  introduced: AuditFinding[] = [],
): string {
  const from = c.currentVersion ?? c.currentRange;
  const lines = [
    `## Converge: ${c.name} ${from} → ${c.latestVersion}  ·  Risk: ${impact.risk.risk}`,
    "",
    ...renderResolution(c, res),
    "",
    ...renderSafety(safety),
    "",
    ...renderIntroduced(introduced),
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

/** PR body for a grouped update (multiple deps in one PR). */
export function renderGroupPrBody(
  groupName: string,
  changes: { name: string; fromRange: string; toRange: string }[],
  introduced: AuditFinding[],
): string {
  const lines = [
    `## Converge group: ${groupName}  ·  ${changes.length} updates`,
    "",
    "### 🔧 Resolution (F1)",
    "- ✅ resolved together; lockfile regenerated once (no package code executed)",
    "- changes:",
    ...changes.map((c) => `  - \`${c.name}\`: \`${c.fromRange}\` → \`${c.toRange}\``),
    "",
    ...renderIntroduced(introduced),
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ];
  return lines.join("\n");
}

/** PR body for a GitHub Actions `uses:` bump (OSV safety, no lockfile/impact). */
export function renderActionsPrBody(c: UpdateCandidate, safety: SafetyVerdict): string {
  const refLine = c.pin
    ? `- \`${c.name}@${c.pin.fromSha.slice(0, 12)}… # ${c.currentRange}\` → ` +
      `\`@${c.pin.toSha.slice(0, 12)}… # ${c.latestVersion}\` (SHA-pinned)`
    : `- \`uses: ${c.name}@${c.currentRange}\` → \`uses: ${c.name}@${c.latestVersion}\``;
  return [
    `## Converge: ${c.name} ${c.currentRange} → ${c.latestVersion}`,
    "",
    "### ⚙️ GitHub Actions",
    `- updates the \`${c.name}\` action ref in \`${c.manifestPath}\` (${c.updateType})`,
    refLine,
    "",
    ...renderSafety(safety),
    "",
    "### Links",
    `- [${c.name}](https://github.com/${c.name})` +
      ` · [release notes](https://github.com/${c.name}/releases/tag/${c.latestVersion})`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ].join("\n");
}

/** PR body for a NuGet PackageReference bump (OSV safety, no lockfile/impact). */
export function renderNugetPrBody(c: UpdateCandidate, safety: SafetyVerdict): string {
  return [
    `## Converge: ${c.name} ${c.currentRange} → ${c.latestVersion}`,
    "",
    "### 📦 NuGet",
    `- updates the \`${c.name}\` PackageReference in \`${c.manifestPath}\` (${c.updateType})`,
    `- \`${c.currentRange}\` → \`${c.latestVersion}\``,
    "",
    ...renderSafety(safety),
    "",
    "### Links",
    `- [nuget.org](https://www.nuget.org/packages/${c.name}/${c.latestVersion})`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ].join("\n");
}

/** PR body for a Composer require constraint bump (OSV safety, no lockfile/impact). */
export function renderComposerPrBody(c: UpdateCandidate, safety: SafetyVerdict): string {
  const to = c.writeRange ?? c.latestVersion;
  return [
    `## Converge: ${c.name} \`${c.currentRange}\` → \`${to}\``,
    "",
    "### 🎼 Composer",
    `- updates the \`${c.name}\` ${c.kind === "dev" ? "require-dev" : "require"} constraint in \`${c.manifestPath}\` (${c.updateType})`,
    `- \`${c.currentRange}\` → \`${to}\` (latest release: \`${c.latestVersion}\`)`,
    "- ⚠️ run `composer update " + c.name + "` to refresh `composer.lock`",
    "",
    ...renderSafety(safety),
    "",
    "### Links",
    `- [Packagist](https://packagist.org/packages/${c.name})`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ].join("\n");
}

/** PR body for a Helm chart dependency bump (scan-only). */
export function renderHelmPrBody(c: UpdateCandidate): string {
  return [
    `## Converge: ${c.name} chart \`${c.currentRange}\` → \`${c.latestVersion}\``,
    "",
    "### ⎈ Helm",
    `- updates the \`${c.name}\` chart dependency in \`${c.manifestPath}\` (${c.updateType})`,
    c.currentVersion ? `- highest version satisfying the old constraint: \`${c.currentVersion}\`` : "",
    "- ⚠️ run `helm dependency update` to refresh `Chart.lock`",
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** PR body for a Terraform provider/module constraint bump (scan-only). */
export function renderTerraformPrBody(c: UpdateCandidate): string {
  const isModule = c.name.split("/").length === 3;
  const kind = isModule ? "module" : "provider";
  const regUrl = `https://registry.terraform.io/${isModule ? "modules" : "providers"}/${c.name}`;
  return [
    `## Converge: ${c.name} \`${c.currentRange}\` → \`${c.latestVersion}\``,
    "",
    "### 🏗️ Terraform",
    `- updates the \`${c.name}\` ${kind} constraint in \`${c.manifestPath}\` (${c.updateType})`,
    c.currentVersion ? `- highest version satisfying the old constraint: \`${c.currentVersion}\`` : "",
    "",
    "### Links",
    `- [Terraform Registry](${regUrl})`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Minimal PR body for Docker base-image bumps (no lockfile/safety/impact). */
export function renderDockerPrBody(c: UpdateCandidate): string {
  return [
    `## Converge: ${c.name} ${c.currentRange} → ${c.latestVersion}`,
    "",
    "### 🐳 Base image",
    `- updates the \`${c.name}\` image tag in \`${c.manifestPath}\` (${c.updateType})`,
    `- \`${c.name}:${c.currentRange}\` → \`${c.name}:${c.latestVersion}\``,
    "",
    "### Links",
    `- [Docker Hub](https://hub.docker.com/_/${c.name.includes("/") ? c.name : c.name}/tags)`,
    "",
    "---",
    `🤖 Generated with [Converge](${CONVERGE_URL})`,
  ].join("\n");
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
