import { describe, it, expect } from "vitest";
import { parsePnpmPeerWarnings } from "../src/resolve/pnpm-cli.js";
import { getResolver } from "../src/resolve/npm-family.js";

// Captured from pnpm 10 output during the spike.
const PNPM_OUTPUT = ` WARN  Issues with peer dependencies found
.
└─┬ @testing-library/react 13.4.0
  ├── ✕ unmet peer react@^18.0.0: found 19.0.0
  └── ✕ unmet peer react-dom@^18.0.0: found 19.0.0

Done in 966ms using pnpm v10.33.0`;

describe("parsePnpmPeerWarnings", () => {
  it("extracts unmet-peer warnings", () => {
    const w = parsePnpmPeerWarnings(PNPM_OUTPUT);
    expect(w).toEqual([
      "unmet peer react@^18.0.0: found 19.0.0",
      "unmet peer react-dom@^18.0.0: found 19.0.0",
    ]);
  });

  it("returns nothing for clean output", () => {
    expect(parsePnpmPeerWarnings("Done in 110ms using pnpm v10.33.0")).toEqual([]);
  });
});

describe("getResolver", () => {
  it("provides resolvers for npm and pnpm with their lockfiles", () => {
    expect(getResolver("npm")?.lockfileNames).toContain("package-lock.json");
    expect(getResolver("pnpm")?.lockfileNames).toContain("pnpm-lock.yaml");
  });

  it("provides resolvers for the whole npm family", () => {
    expect(getResolver("yarn")?.lockfileNames).toContain("yarn.lock");
    expect(getResolver("bun")?.lockfileNames).toContain("bun.lock");
  });
});
