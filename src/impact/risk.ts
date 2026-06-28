import type { UpdateType } from "../core/plan.js";
import type { SafetyDecision } from "../safety/types.js";

export type Risk = "low" | "medium" | "high";

export interface RiskInput {
  updateType: UpdateType;
  /** Number of files in the consuming repo importing the package. */
  usageFiles: number;
  /** Number of automatic co-bumps required to resolve. */
  cobumps: number;
  /** Safety verdict decision (warn raises risk). */
  safety: SafetyDecision;
}

export interface RiskResult {
  risk: Risk;
  reasons: string[];
}

/**
 * Combine the signals we have into a coarse triage risk (SPEC F3.5):
 * semver delta × how embedded the package is × resolution complexity × safety.
 * Deliberately simple and explainable — no LLM.
 */
export function scoreRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];

  // A package nothing imports is near-zero triage risk regardless of semver.
  if (input.usageFiles === 0) {
    return {
      risk: "low",
      reasons: ["not imported anywhere in the repo (transitive or unused)"],
    };
  }

  let score = 0;
  if (input.updateType === "major") {
    score += 3;
    reasons.push("major version bump (possible breaking changes)");
  } else if (input.updateType === "minor") {
    score += 1;
    reasons.push("minor version bump");
  } else {
    reasons.push("patch version bump");
  }

  if (input.usageFiles > 10) {
    score += 2;
    reasons.push(`widely used (${input.usageFiles} files)`);
  } else if (input.usageFiles > 3) {
    score += 1;
    reasons.push(`used in ${input.usageFiles} files`);
  } else {
    reasons.push(`used in ${input.usageFiles} file${input.usageFiles === 1 ? "" : "s"}`);
  }

  if (input.cobumps > 0) {
    score += 1;
    reasons.push(`required ${input.cobumps} co-bump${input.cobumps === 1 ? "" : "s"} to resolve`);
  }
  if (input.safety === "warn") {
    score += 2;
    reasons.push("safety warnings present");
  }

  const risk: Risk = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return { risk, reasons };
}
