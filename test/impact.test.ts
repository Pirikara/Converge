import { describe, it, expect } from "vitest";
import { findUsage, findPythonUsage, findGoUsage } from "../src/impact/usage.js";
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

  it("does not let an import clause span across earlier statements", () => {
    const f = [
      {
        path: "src/x.ts",
        content: `import React from "react";\nimport { useRouter } from "next/navigation";`,
      },
    ];
    const next = findUsage("next", f);
    expect(next.sites).toHaveLength(1);
    expect(next.sites[0]!.line).toBe(2);
    expect(next.sites[0]!.symbols).toEqual(["useRouter"]);
    // and React is not mis-attributed to next
    expect(next.sites[0]!.symbols).not.toContain("React");
  });
});

describe("findPythonUsage", () => {
  const files = [
    { path: "app/main.py", content: "import langchain\nfrom langchain.chains import LLMChain\n" },
    { path: "app/util.py", content: "from langchain_core import x\nimport os\n" },
    { path: "app/no.py", content: "import requests\n" },
  ];

  it("matches import and from-import of the package", () => {
    const u = findPythonUsage("langchain", files);
    expect(u.files).toBe(1); // main.py (langchain), not langchain_core
    expect(u.sites).toHaveLength(2);
  });

  it("matches the underscore form of a hyphenated dist name", () => {
    // langchain-core imports as langchain_core
    expect(findPythonUsage("langchain-core", files).files).toBe(1);
  });

  it("reports zero for unused packages", () => {
    expect(findPythonUsage("numpy", files).files).toBe(0);
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

describe("findGoUsage", () => {
  const files = [
    { path: "main.go", content: 'import (\n\t"fmt"\n\t"github.com/pkg/errors"\n)\n' },
    { path: "sub.go", content: 'import "github.com/pkg/errors/x"\n' },
    { path: "no.go", content: 'import "github.com/other/lib"\n' },
  ];
  it("matches the module path and subpackages", () => {
    const u = findGoUsage("github.com/pkg/errors", files);
    expect(u.files).toBe(2);
  });
});
