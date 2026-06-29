import { describe, it, expect } from "vitest";
import { parseYarnPeerWarnings } from "../src/resolve/yarn-cli.js";
import { getResolver } from "../src/resolve/npm-family.js";

describe("parseYarnPeerWarnings", () => {
  it("extracts Yarn Berry peer warnings (YN0002)", () => {
    const out = [
      "➤ YN0000: ┌ Resolution step",
      "➤ YN0002: │ my-app@workspace:. doesn't provide react (p1a2b3), requested by @testing-library/react",
      "➤ YN0000: └ Completed",
    ].join("\n");
    const w = parseYarnPeerWarnings(out);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("doesn't provide react");
  });

  it("returns nothing for clean output", () => {
    expect(parseYarnPeerWarnings("➤ YN0000: · Done in 0s 200ms")).toEqual([]);
  });
});

describe("getResolver(yarn)", () => {
  it("registers a yarn resolver owning yarn.lock", () => {
    expect(getResolver("yarn")?.lockfileNames).toContain("yarn.lock");
  });
});
