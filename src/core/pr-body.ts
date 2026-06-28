import type { UpdateCandidate } from "../adapters/types.js";

const REGISTRY_BASE = "https://www.npmjs.com/package";

/**
 * Render the PR body. M0 reports the resolved bump and links; the safety (F2),
 * impact (F3), and deprecation (F4) sections are wired in later milestones and
 * are shown here as explicitly pending so the report never overclaims.
 */
export function renderPrBody(c: UpdateCandidate, newRange: string): string {
  const from = c.currentVersion ?? c.currentRange;
  const lines = [
    `## SafeBump: ${c.name} ${from} → ${c.latestVersion}`,
    "",
    `Updates \`${c.name}\` (${c.kind}) in \`${c.dir}\` from \`${c.currentRange}\` to \`${newRange}\`.`,
    "",
    "### 🔧 Resolution (F1)",
    `- Update type: **${c.updateType}**`,
    `- Range edit only (lockfile resolution & sandbox verification: _pending M1_)`,
    "",
    "### ✅ Safety (F2)",
    "- _pending M2_ — malware / advisory / cooldown checks not yet enforced",
    "",
    "### 📋 Impact (F3)",
    "- _pending M3_ — breaking-change & usage mapping not yet attached",
    "",
    "### Links",
    `- [npm](${REGISTRY_BASE}/${c.name})`,
    `- [${c.name}@${c.latestVersion}](${REGISTRY_BASE}/${c.name}/v/${c.latestVersion})`,
    "",
    "---",
    "🤖 Generated with [SafeBump](https://github.com/Pirikara/SafeBump)",
  ];
  return lines.join("\n");
}
