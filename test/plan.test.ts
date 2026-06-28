import { describe, it, expect, vi, beforeEach } from "vitest";
import { planUpdates } from "../src/core/plan.js";
import type { GitHubClient } from "../src/github/client.js";
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
    getFile: vi.fn(async () => ({ content: pkgJson, sha: "abc" })),
  } as unknown as GitHubClient;
}

describe("planUpdates", () => {
  beforeEach(() => fetchMock.mockReset());

  it("plans only allowed update types and produces a minimal edit", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("next")) return packument("next", ["16.1.5", "16.2.9"], "16.2.9");
      if (u.includes("eslint")) return packument("eslint", ["9.0.0", "10.6.0"], "10.6.0");
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const { base, plans } = await planUpdates(fakeGh(), { owner: "o", repo: "r" }, defaultConfig(), {
      allow: ["minor", "patch"],
      limit: 5,
    });

    expect(base).toBe("main");
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.candidate.name).toBe("next");
    expect(p.branch).toBe("safebump/npm/frontend-next-16.2.9");
    expect(p.newContent).toContain('"next": "16.2.9"');
    expect(p.newContent).toContain('"eslint": "^9.0.0"'); // untouched
    expect(p.body).toContain("pending M2");
  });

  it("respects the limit", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("next")) return packument("next", ["16.1.5", "16.2.9"], "16.2.9");
      if (u.includes("eslint")) return packument("eslint", ["9.0.0", "10.6.0"], "10.6.0");
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { plans } = await planUpdates(fakeGh(), { owner: "o", repo: "r" }, defaultConfig(), {
      allow: ["major", "minor", "patch"],
      limit: 1,
    });
    expect(plans).toHaveLength(1);
  });
});
