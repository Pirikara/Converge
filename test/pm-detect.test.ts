import { describe, it, expect } from "vitest";
import { decidePackageManager, isResolvable } from "../src/resolve/pm-detect.js";

describe("decidePackageManager", () => {
  it("trusts the packageManager field over lockfiles", () => {
    expect(
      decidePackageManager({ packageManagerField: "pnpm@9.1.0", lockfiles: ["package-lock.json"] }),
    ).toBe("pnpm");
    expect(decidePackageManager({ packageManagerField: "yarn@4.1.0", lockfiles: [] })).toBe("yarn");
    expect(decidePackageManager({ packageManagerField: "bun@1.1.0", lockfiles: [] })).toBe("bun");
  });

  it("infers from the lockfile when no field is present", () => {
    expect(decidePackageManager({ lockfiles: ["pnpm-lock.yaml"] })).toBe("pnpm");
    expect(decidePackageManager({ lockfiles: ["yarn.lock"] })).toBe("yarn");
    expect(decidePackageManager({ lockfiles: ["bun.lockb"] })).toBe("bun");
    expect(decidePackageManager({ lockfiles: ["package-lock.json"] })).toBe("npm");
  });

  it("defaults to npm with no signal", () => {
    expect(decidePackageManager({ lockfiles: [] })).toBe("npm");
  });

  it("only npm is resolvable for now", () => {
    expect(isResolvable("npm")).toBe(true);
    expect(isResolvable("pnpm")).toBe(false);
    expect(isResolvable("yarn")).toBe(false);
    expect(isResolvable("bun")).toBe(false);
  });
});
