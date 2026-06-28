import { describe, it, expect } from "vitest";
import { bumpRange, editPackageJsonRange } from "../src/adapters/npm/range.js";

describe("bumpRange", () => {
  it("preserves caret/tilde/exact/comparator operators", () => {
    expect(bumpRange("^1.2.0", "2.0.0")).toBe("^2.0.0");
    expect(bumpRange("~1.2.0", "1.3.1")).toBe("~1.3.1");
    expect(bumpRange("1.2.0", "2.0.0")).toBe("2.0.0");
    expect(bumpRange(">=1.0.0", "2.1.0")).toBe(">=2.1.0");
  });

  it("falls back to caret for compound ranges", () => {
    expect(bumpRange("1.x || 2.x", "3.0.0")).toBe("^3.0.0");
  });

  it("returns the original range for invalid target versions", () => {
    expect(bumpRange("^1.0.0", "not-a-version")).toBe("^1.0.0");
  });
});

describe("editPackageJsonRange", () => {
  const pkg = `{
  "dependencies": {
    "left-pad": "^1.2.0",
    "react": "^18.0.0"
  }
}`;

  it("replaces only the targeted dependency with a minimal edit", () => {
    const out = editPackageJsonRange(pkg, "react", "^18.0.0", "^19.0.0");
    expect(out).toContain('"react": "^19.0.0"');
    expect(out).toContain('"left-pad": "^1.2.0"');
  });

  it("throws when the name/range pair is absent", () => {
    expect(() => editPackageJsonRange(pkg, "react", "^17.0.0", "^19.0.0")).toThrow();
  });
});
