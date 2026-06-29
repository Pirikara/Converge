import { describe, it, expect } from "vitest";
import { parseBunPeerWarnings } from "../src/resolve/bun-cli.js";
import { getResolver } from "../src/resolve/npm-family.js";

describe("parseBunPeerWarnings", () => {
  it("extracts peer-dependency warnings", () => {
    const out = "warn: incorrect peer dependency \"react@19.0.0\"\nResolved, downloaded";
    const w = parseBunPeerWarnings(out);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("peer dependency");
  });

  it("returns nothing for clean output", () => {
    expect(parseBunPeerWarnings("Saved lockfile")).toEqual([]);
  });
});

describe("getResolver(bun)", () => {
  it("registers a bun resolver owning bun.lock", () => {
    expect(getResolver("bun")?.lockfileNames).toContain("bun.lock");
  });
});
