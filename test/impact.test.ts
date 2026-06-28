import { describe, it, expect } from "vitest";
import { findUsage } from "../src/impact/usage.js";
import { scoreRisk } from "../src/impact/risk.js";

describe("findUsage", () => {
  const files = [
    { path: "src/a.ts", content: `import React, { useState, useEffect as ue } from "react";\nconst x = 1;` },
    { path: "src/b.tsx", content: `import * as React from 'react';\nimport { render } from "react-dom/client";` },
    { path: "src/c.js", content: `const _ = require("lodash");\nconst c = await import('chalk');` },
    { path: "src/d.ts", content: `import { foo } from "react-dom";` },
  ];

  it("maps react imports with symbols, not matching react-dom", () => {
    const u = findUsage("react", files);
    expect(u.files).toBe(2); // a.ts, b.tsx
    const a = u.sites.find((s) => s.file === "src/a.ts")!;
    expect(a.symbols).toEqual(["React", "useState", "ue"]);
    const b = u.sites.find((s) => s.file === "src/b.tsx")!;
    expect(b.symbols).toContain("React");
  });

  it("matches subpath specifiers (react-dom/client)", () => {
    const u = findUsage("react-dom", files);
    expect(u.files).toBe(2); // b.tsx (subpath) + d.ts
  });

  it("detects require and dynamic import", () => {
    expect(findUsage("lodash", files).sites[0]!.kind).toBe("require");
    expect(findUsage("chalk", files).sites[0]!.kind).toBe("dynamic-import");
  });

  it("reports zero for unused packages", () => {
    expect(findUsage("vue", files).files).toBe(0);
  });
});

describe("scoreRisk", () => {
  it("is low when nothing imports the package", () => {
    const r = scoreRisk({ updateType: "major", usageFiles: 0, cobumps: 0, safety: "allow" });
    expect(r.risk).toBe("low");
  });

  it("is high for a widely-used major bump", () => {
    const r = scoreRisk({ updateType: "major", usageFiles: 20, cobumps: 0, safety: "allow" });
    expect(r.risk).toBe("high");
  });

  it("is low for a patch used in a couple of files", () => {
    const r = scoreRisk({ updateType: "patch", usageFiles: 2, cobumps: 0, safety: "allow" });
    expect(r.risk).toBe("low");
  });

  it("raises risk on safety warnings", () => {
    const r = scoreRisk({ updateType: "patch", usageFiles: 1, cobumps: 0, safety: "warn" });
    expect(r.risk).toBe("medium");
  });
});
