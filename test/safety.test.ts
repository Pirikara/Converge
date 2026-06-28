import { describe, it, expect, vi } from "vitest";
import { evaluateSafety, type SafetyDeps } from "../src/safety/gate.js";
import type { OsvVuln } from "../src/safety/osv.js";
import { defaultConfig } from "../src/config/schema.js";

const policy = defaultConfig().safety; // cooldownDays 3, onKnownMalware block, onSuspicious hold

const NOW = new Date("2026-06-28T00:00:00Z").getTime();
const OLD = "2026-01-01T00:00:00Z"; // > 3 days old
const FRESH = "2026-06-27T12:00:00Z"; // < 3 days old

function deps(vulns: OsvVuln[]): SafetyDeps {
  return { queryOsv: vi.fn(async () => vulns), now: () => NOW };
}

function vuln(over: Partial<OsvVuln>): OsvVuln {
  return {
    id: "GHSA-x",
    aliases: [],
    summary: "",
    severity: "moderate",
    malware: false,
    url: "https://osv.dev/vulnerability/GHSA-x",
    ...over,
  };
}

describe("evaluateSafety", () => {
  it("allows a clean, matured version", async () => {
    const v = await evaluateSafety(
      { ecosystem: "npm", name: "next", version: "16.2.9", publishedAt: OLD },
      policy,
      deps([]),
    );
    expect(v.decision).toBe("allow");
    expect(v.signals).toHaveLength(0);
  });

  it("blocks a known-malware target", async () => {
    const v = await evaluateSafety(
      { ecosystem: "npm", name: "evil", version: "1.0.0", publishedAt: OLD },
      policy,
      deps([vuln({ id: "MAL-2026-1", malware: true, severity: "critical" })]),
    );
    expect(v.decision).toBe("block");
    expect(v.signals[0]!.kind).toBe("malware");
  });

  it("blocks a high-severity vulnerability but warns on moderate", async () => {
    const high = await evaluateSafety(
      { ecosystem: "npm", name: "p", version: "1.0.0", publishedAt: OLD },
      policy,
      deps([vuln({ severity: "high" })]),
    );
    expect(high.decision).toBe("block");

    const mod = await evaluateSafety(
      { ecosystem: "npm", name: "p", version: "1.0.0", publishedAt: OLD },
      policy,
      deps([vuln({ severity: "moderate" })]),
    );
    expect(mod.decision).toBe("warn");
  });

  it("holds a version still within cooldown", async () => {
    const v = await evaluateSafety(
      { ecosystem: "npm", name: "p", version: "2.0.0", publishedAt: FRESH },
      policy,
      deps([]),
    );
    expect(v.decision).toBe("hold");
    expect(v.signals[0]!.kind).toBe("cooldown");
  });

  it("allowlist overrides even malware", async () => {
    const v = await evaluateSafety(
      { ecosystem: "npm", name: "evil", version: "1.0.0", publishedAt: FRESH },
      { ...policy, allow: [{ pkg: "evil", version: "1.0.0" }] },
      deps([vuln({ malware: true, severity: "critical" })]),
    );
    expect(v.decision).toBe("allow");
    expect(v.signals[0]!.kind).toBe("allowlisted");
  });
});
