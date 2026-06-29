import { describe, it, expect } from "vitest";
import { computeDelta } from "../src/core/update-audit.js";
import { parseLockfile } from "../src/audit/lockfiles.js";

describe("computeDelta", () => {
  it("returns packages added or version-changed in next", () => {
    const prev = [
      { name: "a", version: "1.0.0" },
      { name: "b", version: "1.0.0" },
    ];
    const next = [
      { name: "a", version: "1.0.0" }, // unchanged
      { name: "b", version: "2.0.0" }, // changed
      { name: "c", version: "1.0.0" }, // added (transitive)
    ];
    expect(computeDelta(prev, next)).toEqual([
      { name: "b", version: "2.0.0" },
      { name: "c", version: "1.0.0" },
    ]);
  });
});

describe("parseLockfile dispatch", () => {
  it("routes by lockfile basename to the right ecosystem/parser", () => {
    const npm = parseLockfile(
      "frontend/package-lock.json",
      JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/x": { version: "1.0.0" } } }),
    );
    expect(npm).toEqual({ ecosystem: "npm", packages: [{ name: "x", version: "1.0.0" }] });

    const go = parseLockfile("go.sum", "github.com/x/y v1.0.0 h1:aaa=");
    expect(go?.ecosystem).toBe("Go");
    expect(go?.packages).toEqual([{ name: "github.com/x/y", version: "1.0.0" }]);

    expect(parseLockfile("requirements.txt", "flask==1.0")).toBeNull();
  });
});
