import type { UpdateCandidate } from "../adapters/types.js";
import type { SafetyDecision } from "../safety/types.js";
import { findUsage, findPythonUsage, findGoUsage, findRubyUsage, type SourceFile, type UsageReport } from "./usage.js";
import { scoreRisk, type RiskResult } from "./risk.js";

export interface ImpactReport {
  usage: UsageReport;
  risk: RiskResult;
}

/**
 * Build the F3 impact report for a candidate from the consuming repo's source.
 * M3 slice: usage mapping (F3.3) + risk score (F3.5). Release-note extraction
 * (F3.1) and public-API diffing (F3.2) attach in later increments.
 */
export function analyzeImpact(
  candidate: UpdateCandidate,
  sourceFiles: SourceFile[],
  cobumps: number,
  safety: SafetyDecision,
): ImpactReport {
  const usage =
    candidate.ecosystem === "pip"
      ? findPythonUsage(candidate.name, sourceFiles)
      : candidate.ecosystem === "gomod"
        ? findGoUsage(candidate.name, sourceFiles)
        : candidate.ecosystem === "rubygems"
          ? findRubyUsage(candidate.name, sourceFiles)
          : findUsage(candidate.name, sourceFiles);
  const risk = scoreRisk({
    updateType: candidate.updateType,
    usageFiles: usage.files,
    cobumps,
    safety,
  });
  return { usage, risk };
}
