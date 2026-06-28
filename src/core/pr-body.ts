import type { UpdateCandidate } from "../adapters/types.js";
import type { ResolveOutcome } from "../resolve/types.js";

const REGISTRY_BASE = "https://www.npmjs.com/package";

/**
 * Render the PR body from the resolution outcome. M1 reports the resolved
 * change set (including automatic co-bumps) and whether the lockfile was
 * regenerated. Safety (F2), impact (F3), and deprecation (F4) are shown as
 * explicitly pending so the report never overclaims.
 */
export function renderPrBody(
  c: UpdateCandidate,
  outcome: ResolveOutcome,
): string {
  const from = c.currentVersion ?? c.currentRange;
  const lines = [
    `## SafeBump: ${c.name} ${from} → ${c.latestVersion}`,
    "",
    "### 🔧 Resolution (F1)",
  ];

  if (outcome.status === "unsolvable") {
    lines.push(
      `- ❌ **could not resolve** — ${outcome.reason}`,
      `- attempted: ${outcome.attempted.join(" → ")}`,
      "",
      "<details><summary>npm conflict output</summary>",
      "",
      "```",
      outcome.rawError,
      "```",
      "</details>",
    );
  } else {
    const method =
      outcome.status === "resolved-cobump"
        ? `resolved via co-bump (${outcome.strategy})`
        : "resolved directly";
    lines.push(`- ✅ ${method}; lockfile regenerated (no package code executed)`);
    lines.push("- changes:");
    for (const ch of outcome.changes) {
      const tag = ch.cobump ? " _(auto co-bump)_" : "";
      lines.push(`  - \`${ch.name}\`: \`${ch.fromRange}\` → \`${ch.toRange}\`${tag}`);
    }
  }

  lines.push(
    "",
    "### ✅ Safety (F2)",
    "- _pending M2_ — malware / advisory / cooldown checks not yet enforced",
    "",
    "### 📋 Impact (F3)",
    "- _pending M3_ — breaking-change & usage mapping not yet attached",
    "",
    "### Links",
    `- [npm](${REGISTRY_BASE}/${c.name}) · [${c.name}@${c.latestVersion}](${REGISTRY_BASE}/${c.name}/v/${c.latestVersion})`,
    "",
    "---",
    "🤖 Generated with [SafeBump](https://github.com/Pirikara/SafeBump)",
  );
  return lines.join("\n");
}

/** PR title, including a co-bump count when applicable. */
export function renderPrTitle(c: UpdateCandidate, outcome: ResolveOutcome): string {
  const from = c.currentVersion ?? c.currentRange;
  const base = `bump ${c.name} from ${from} to ${c.latestVersion}`;
  if (outcome.status === "resolved-cobump") {
    const extra = outcome.changes.filter((ch) => ch.cobump).length;
    return `${base} (+${extra} co-bump${extra === 1 ? "" : "s"})`;
  }
  return base;
}
