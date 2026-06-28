import { describe, it, expect } from "vitest";
import { provenanceStatus } from "../src/safety/provenance.js";
import { evaluateSafety } from "../src/safety/gate.js";
import { defaultConfig } from "../src/config/schema.js";
import type { PackageMeta } from "../src/adapters/types.js";

function meta(provenance: Record<string, boolean>): PackageMeta {
  const versions = Object.keys(provenance);
  return {
    name: "pkg",
    latest: versions[versions.length - 1]!,
    versions,
    publishedAt: {},
    deprecated: null,
    deprecations: {},
    provenance,
    repositoryUrl: null,
  };
}

describe("provenanceStatus", () => {
  it("detects a downgrade when the current version had provenance", () => {
    const s = provenanceStatus(meta({ "1.0.0": true, "1.1.0": false }), "1.0.0", "1.1.0");
    expect(s.targetHasProvenance).toBe(false);
    expect(s.baselineHadProvenance).toBe(true);
    expect(s.baselineVersion).toBe("1.0.0");
  });

  it("uses the predecessor as baseline when current lacks provenance", () => {
    const s = provenanceStatus(
      meta({ "1.0.0": false, "2.0.0": true, "2.1.0": false }),
      "1.0.0",
      "2.1.0",
    );
    expect(s.baselineHadProvenance).toBe(true);
    expect(s.baselineVersion).toBe("2.0.0");
  });

  it("is not a downgrade when the target keeps provenance", () => {
    const s = provenanceStatus(meta({ "1.0.0": true, "1.1.0": true }), "1.0.0", "1.1.0");
    expect(s.targetHasProvenance).toBe(true);
  });

  it("no baseline when the package never used provenance", () => {
    const s = provenanceStatus(meta({ "1.0.0": false, "1.1.0": false }), "1.0.0", "1.1.0");
    expect(s.baselineHadProvenance).toBe(false);
  });
});

describe("evaluateSafety with provenance", () => {
  const policy = defaultConfig().safety; // onSuspicious: hold

  it("holds a provenance downgrade", async () => {
    const v = await evaluateSafety(
      {
        ecosystem: "npm",
        name: "pkg",
        version: "1.1.0",
        provenance: { targetHasProvenance: false, baselineHadProvenance: true, baselineVersion: "1.0.0" },
      },
      policy,
      { queryOsv: async () => [], now: () => Date.now() },
    );
    expect(v.decision).toBe("hold");
    expect(v.signals[0]!.kind).toBe("provenance-downgrade");
  });

  it("allows when provenance is retained", async () => {
    const v = await evaluateSafety(
      {
        ecosystem: "npm",
        name: "pkg",
        version: "1.1.0",
        provenance: { targetHasProvenance: true, baselineHadProvenance: true },
      },
      policy,
      { queryOsv: async () => [], now: () => Date.now() },
    );
    expect(v.decision).toBe("allow");
  });
});
