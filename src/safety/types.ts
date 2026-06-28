/** F2 safety gate types (SPEC §5 F2). */

export type SafetyDecision = "allow" | "warn" | "hold" | "block";

export type SignalKind =
  | "malware" // OSV MAL-* advisory
  | "vulnerability" // OSV non-malware advisory
  | "cooldown" // version published too recently
  | "allowlisted"; // explicitly permitted in config

export type Severity = "critical" | "high" | "moderate" | "low" | "info";

export interface SafetySignal {
  kind: SignalKind;
  severity: Severity;
  detail: string;
  /** Source identifier (e.g. OSV id) and link, when available. */
  id?: string;
  url?: string;
}

export interface SafetyVerdict {
  /** Final, policy-applied decision (most severe signal wins). */
  decision: SafetyDecision;
  signals: SafetySignal[];
}

/** Severity ordering for choosing the dominant signal. */
export const DECISION_RANK: Record<SafetyDecision, number> = {
  allow: 0,
  warn: 1,
  hold: 2,
  block: 3,
};

export function worst(a: SafetyDecision, b: SafetyDecision): SafetyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}
