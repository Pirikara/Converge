import type { Config } from "../config/schema.js";
import { queryOsv as realQueryOsv, type OsvVuln } from "./osv.js";
import {
  worst,
  type SafetyDecision,
  type SafetySignal,
  type SafetyVerdict,
} from "./types.js";

export interface SafetyInput {
  ecosystem: string;
  name: string;
  /** Target version being proposed. */
  version: string;
  /** ISO publish time of the target version, when known (for cooldown). */
  publishedAt?: string;
}

export interface SafetyDeps {
  queryOsv: (ecosystem: string, name: string, version: string) => Promise<OsvVuln[]>;
  now: () => number;
}

const defaultDeps: SafetyDeps = { queryOsv: realQueryOsv, now: () => Date.now() };

type Policy = Config["safety"];

function vulnDecision(v: OsvVuln, policy: Policy): SafetyDecision {
  if (v.malware) return policy.onKnownMalware;
  // Introducing a high/critical vuln by upgrading is a block; lesser → warn.
  return v.severity === "critical" || v.severity === "high" ? "block" : "warn";
}

function ageDays(publishedAt: string, now: number): number {
  return (now - new Date(publishedAt).getTime()) / 86_400_000;
}

/**
 * Evaluate the F2 safety gate for a target package version. Runs BEFORE
 * resolution so dangerous versions are never installed (SPEC §10.2 self-defense).
 */
export async function evaluateSafety(
  input: SafetyInput,
  policy: Policy,
  deps: SafetyDeps = defaultDeps,
): Promise<SafetyVerdict> {
  // Explicit allowlist overrides everything.
  if (policy.allow.some((a) => a.pkg === input.name && a.version === input.version)) {
    return {
      decision: "allow",
      signals: [
        {
          kind: "allowlisted",
          severity: "info",
          detail: `${input.name}@${input.version} is allowlisted in safebump.json`,
        },
      ],
    };
  }

  const signals: SafetySignal[] = [];
  let decision: SafetyDecision = "allow";

  const vulns = await deps.queryOsv(input.ecosystem, input.name, input.version);
  for (const v of vulns) {
    signals.push({
      kind: v.malware ? "malware" : "vulnerability",
      severity: v.severity,
      detail: v.malware
        ? `known-malware advisory ${v.id}`
        : `${v.severity} — ${v.summary || v.id}`,
      id: v.id,
      url: v.url,
    });
    decision = worst(decision, vulnDecision(v, policy));
  }

  if (input.publishedAt && policy.cooldownDays > 0) {
    const age = ageDays(input.publishedAt, deps.now());
    if (age < policy.cooldownDays) {
      signals.push({
        kind: "cooldown",
        severity: "info",
        detail: `published ${age.toFixed(1)}d ago (< ${policy.cooldownDays}d cooldown)`,
      });
      decision = worst(decision, "hold");
    }
  }

  return { decision, signals };
}
