import { describe, it, expect } from "vitest";
import { maturedTarget } from "../src/core/cooldown.js";
import type { PackageMeta, UpdateCandidate, EcosystemId } from "../src/adapters/types.js";

const NOW = Date.parse("2026-07-05T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const policy = (cooldownDays: number) =>
  ({ cooldownDays, onKnownMalware: "block", onSuspicious: "warn", allow: [] }) as unknown as import("../src/config/schema.js").Config["safety"];

function cand(over: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    ecosystem: "npm" as EcosystemId,
    manifestPath: "package.json",
    dir: ".",
    name: "left-pad",
    kind: "prod",
    currentRange: "^1.0.0",
    currentVersion: "1.0.0",
    latestVersion: "1.3.0",
    updateType: "minor",
    ...over,
  } as UpdateCandidate;
}

function meta(publishedAt: Record<string, string>): PackageMeta {
  return {
    name: "left-pad",
    latest: "1.3.0",
    versions: Object.keys(publishedAt),
    publishedAt,
    deprecated: null,
    deprecations: {},
    provenance: {},
    repositoryUrl: null,
  };
}

describe("maturedTarget (cooldown as maturity selection)", () => {
  it("steps down to the newest matured version when the latest is too fresh", () => {
    const m = maturedTarget(
      cand(),
      meta({ "1.0.0": daysAgo(400), "1.2.0": daysAgo(30), "1.3.0": daysAgo(1) }),
      policy(7),
      NOW,
    );
    expect(m).toEqual({ latestVersion: "1.2.0", updateType: "minor" });
  });

  it("keeps the latest when it is already matured", () => {
    const m = maturedTarget(
      cand(),
      meta({ "1.0.0": daysAgo(400), "1.3.0": daysAgo(30) }),
      policy(7),
      NOW,
    );
    expect(m).toBeNull();
  });

  it("holds (returns null) when no version between current and target is matured", () => {
    const m = maturedTarget(
      cand(),
      meta({ "1.0.0": daysAgo(400), "1.2.0": daysAgo(2), "1.3.0": daysAgo(1) }),
      policy(7),
      NOW,
    );
    expect(m).toBeNull();
  });

  it("never steps above the chosen target or at/below current", () => {
    const m = maturedTarget(
      cand({ currentVersion: "1.1.0", latestVersion: "1.2.0" }),
      meta({
        "1.0.0": daysAgo(400),
        "1.1.0": daysAgo(400),
        "1.2.0": daysAgo(1),
        "1.5.0": daysAgo(400), // newer than target but must not be picked
      }),
      policy(7),
      NOW,
    );
    expect(m).toBeNull(); // only mature option is <= current
  });

  it("bypasses cooldown for security candidates (keeps the fix version)", () => {
    const m = maturedTarget(
      cand({ security: { advisories: [] } as never }),
      meta({ "1.0.0": daysAgo(400), "1.2.0": daysAgo(30), "1.3.0": daysAgo(1) }),
      policy(7),
      NOW,
    );
    expect(m).toBeNull();
  });

  it("is disabled when cooldownDays is 0", () => {
    const m = maturedTarget(cand(), meta({ "1.3.0": daysAgo(1) }), policy(0), NOW);
    expect(m).toBeNull();
  });

  it("skips ecosystems without a publish-date scheme (e.g. nuget)", () => {
    const m = maturedTarget(
      cand({ ecosystem: "nuget" as EcosystemId }),
      meta({ "1.0.0": daysAgo(400), "1.2.0": daysAgo(30), "1.3.0": daysAgo(1) }),
      policy(7),
      NOW,
    );
    expect(m).toBeNull();
  });

  it("classifies cargo 0.x maturity step-downs the Cargo way", () => {
    const m = maturedTarget(
      cand({ ecosystem: "cargo" as EcosystemId, currentVersion: "0.24.0", latestVersion: "0.26.0", updateType: "major" }),
      meta({ "0.24.0": daysAgo(400), "0.24.5": daysAgo(30), "0.26.0": daysAgo(1) }),
      policy(7),
      NOW,
    );
    expect(m).toEqual({ latestVersion: "0.24.5", updateType: "patch" });
  });
});
