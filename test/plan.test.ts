import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectCandidates, branchName } from "../src/core/plan.js";
import type { GitHubClient } from "../src/github/client.js";
import type { UpdateCandidate } from "../src/adapters/types.js";
import { defaultConfig } from "../src/config/schema.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function packument(name: string, versions: string[], latest: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name,
      "dist-tags": { latest },
      versions: Object.fromEntries(versions.map((v) => [v, {}])),
      time: {},
    }),
  };
}

const pkgJson = JSON.stringify(
  { dependencies: { next: "16.1.5" }, devDependencies: { eslint: "^9.0.0" } },
  null,
  2,
);

function fakeGh(): GitHubClient {
  return {
    getDefaultBranch: vi.fn(async () => "main"),
    findManifestPaths: vi.fn(async () => ["frontend/package.json"]),
    findManifestPathsMatching: vi.fn(async () => []),
    getFile: vi.fn(async () => ({ content: pkgJson, sha: "abc" })),
  } as unknown as GitHubClient;
}

describe("selectCandidates", () => {
  beforeEach(() => fetchMock.mockReset());

  it("selects only allowed update types", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("next")) return packument("next", ["16.1.5", "16.2.9"], "16.2.9");
      if (u.includes("eslint")) return packument("eslint", ["9.0.0", "10.6.0"], "10.6.0");
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { base, selected } = await selectCandidates(
      fakeGh(),
      { owner: "o", repo: "r" },
      defaultConfig(),
      { allow: ["minor", "patch"], limit: 5 },
    );
    expect(base).toBe("main");
    expect(selected.map((c) => c.name)).toEqual(["next"]); // eslint is major
  });

  it("respects the limit", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("next")) return packument("next", ["16.1.5", "16.2.9"], "16.2.9");
      if (u.includes("eslint")) return packument("eslint", ["9.0.0", "10.6.0"], "10.6.0");
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { selected } = await selectCandidates(
      fakeGh(),
      { owner: "o", repo: "r" },
      defaultConfig(),
      { allow: ["major", "minor", "patch"], limit: 1 },
    );
    expect(selected).toHaveLength(1);
  });
});

describe("branchName", () => {
  it("encodes dir, name, and target version idempotently", () => {
    const c = {
      ecosystem: "npm",
      dir: "frontend",
      name: "@scope/pkg",
      latestVersion: "2.0.0",
    } as UpdateCandidate;
    expect(branchName(c)).toBe("converge/npm/frontend-scope-pkg-2.0.0");
  });
});
