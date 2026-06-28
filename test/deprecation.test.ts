import { describe, it, expect } from "vitest";
import { detectDeprecation, parseReplacement } from "../src/deprecation/detect.js";
import type { PackageMeta } from "../src/adapters/types.js";

const NOW = new Date("2026-06-28T00:00:00Z").getTime();
const opts = { staleDays: 730, now: NOW };

function meta(over: Partial<PackageMeta>): PackageMeta {
  return {
    name: "pkg",
    latest: "2.0.0",
    versions: ["1.0.0", "2.0.0"],
    publishedAt: { "1.0.0": "2025-01-01T00:00:00Z", "2.0.0": "2026-06-01T00:00:00Z" },
    deprecated: null,
    deprecations: {},
    repositoryUrl: null,
    ...over,
  };
}

describe("parseReplacement", () => {
  it("extracts a suggested replacement package", () => {
    expect(parseReplacement("request has been deprecated, use got instead")).toBe("got");
    expect(parseReplacement("No longer supported. Use @scope/new-pkg instead")).toBe("@scope/new-pkg");
    expect(parseReplacement("just deprecated, sorry")).toBeUndefined();
  });
});

describe("detectDeprecation", () => {
  it("flags a package-wide deprecation with replacement", () => {
    const f = detectDeprecation(
      { name: "request", currentVersion: "2.0.0", targetVersion: "2.0.0" },
      meta({ deprecated: "deprecated, use got instead", deprecations: { "2.0.0": "deprecated, use got instead" } }),
      opts,
    );
    expect(f[0]!.kind).toBe("package");
    expect(f[0]!.replacement).toBe("got");
  });

  it("flags upgrading into a deprecated target version", () => {
    const f = detectDeprecation(
      { name: "pkg", currentVersion: "1.0.0", targetVersion: "2.0.0" },
      meta({ deprecated: null, deprecations: { "2.0.0": "this release is broken, use 2.0.1" } }),
      opts,
    );
    expect(f.some((x) => x.kind === "target-version")).toBe(true);
  });

  it("flags a deprecated current version", () => {
    const f = detectDeprecation(
      { name: "pkg", currentVersion: "1.0.0", targetVersion: "2.0.0" },
      meta({ deprecations: { "1.0.0": "security issue, upgrade" } }),
      opts,
    );
    expect(f.some((x) => x.kind === "current-version")).toBe(true);
  });

  it("flags staleness when last release is old", () => {
    const f = detectDeprecation(
      { name: "pkg", currentVersion: "2.0.0", targetVersion: "2.0.0" },
      meta({ publishedAt: { "2.0.0": "2020-01-01T00:00:00Z" } }),
      opts,
    );
    expect(f.some((x) => x.kind === "stale")).toBe(true);
  });

  it("reports nothing for a maintained, current package", () => {
    expect(detectDeprecation({ name: "pkg", currentVersion: "2.0.0", targetVersion: "2.0.0" }, meta({}), opts)).toEqual([]);
  });
});
