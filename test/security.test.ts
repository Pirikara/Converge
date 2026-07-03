import { describe, it, expect, vi, beforeEach } from "vitest";
import { securityCandidates } from "../src/core/security.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { GitHubClient } from "../src/github/client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResp(obj: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => "" };

function npmPackument(name: string, versions: string[], latest: string) {
  return jsonResp({
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
    time: {},
  });
}

/** gh fake serving a package.json (+ optional extra files like a lockfile). */
function ghWith(pkgJson: object, extra: Record<string, string> = {}): GitHubClient {
  const files: Record<string, string> = { "package.json": JSON.stringify(pkgJson), ...extra };
  return {
    findManifestPaths: vi.fn(async (_ref: unknown, _base: string, filename: string) =>
      filename === "package.json" ? ["package.json"] : [],
    ),
    findManifestPathsMatching: vi.fn(async () => []),
    getFile: vi.fn(async (_ref: unknown, p: string) =>
      files[p] != null ? { content: files[p], sha: "s" } : null,
    ),
  } as unknown as GitHubClient;
}

function npmLock(pkgVersions: Record<string, string>) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(pkgVersions).map(([n, v]) => [`node_modules/${n}`, { version: v }]),
    ),
  });
}

const config = ConfigSchema.parse({});
const ref = { owner: "o", repo: "r" };

/**
 * Route OSV by the version in the request body. `vulnAt` maps version → advisory
 * ids affecting it (absent = clean).
 */
function routeOsv(name: string, versions: string[], latest: string, vulnAt: Record<string, string[]>) {
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
    if (typeof url !== "string") return notFound; // stray cleanup fetch
    if (url.includes("registry.npmjs.org")) return npmPackument(name, versions, latest);
    if (url.includes("/v1/querybatch")) {
      const { queries } = JSON.parse(init!.body!) as { queries: { version: string }[] };
      return jsonResp({ results: queries.map((q) => ({ vulns: (vulnAt[q.version] ?? []).map((id) => ({ id })) })) });
    }
    if (url.includes("/v1/query")) {
      const { version } = JSON.parse(init!.body!) as { version: string };
      return jsonResp({ vulns: (vulnAt[version] ?? []).map((id) => ({ id, database_specific: { severity: "HIGH" } })) });
    }
    return notFound;
  });
}

beforeEach(() => fetchMock.mockReset());

describe("securityCandidates", () => {
  it("opens a fix to the lowest patched version for a pinned, vulnerable dep", async () => {
    routeOsv("leftpad", ["1.0.0", "1.0.1", "1.0.2", "1.1.0"], "1.1.0", {
      "1.0.0": ["GHSA-xxxx-yyyy-zzzz"], // current is vulnerable
      // 1.0.1+ are clean
    });
    const gh = ghWith({ dependencies: { leftpad: "1.0.0" } });
    const out = await securityCandidates(gh, ref, config, "main");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "leftpad",
      currentVersion: "1.0.0",
      latestVersion: "1.0.1", // lowest fixed (strategy default)
      security: { ids: ["GHSA-xxxx-yyyy-zzzz"], severity: "high" },
    });
  });

  it("uses the LOCKED version, not the range top (catches a lagging lockfile)", async () => {
    // range floats to a patched 4.20.0, but the lockfile is stuck on vulnerable 4.17.1.
    routeOsv("weblib", ["4.17.1", "4.18.0", "4.20.0"], "4.20.0", { "4.17.1": ["CVE-2024-9999"] });
    const gh = ghWith(
      { dependencies: { weblib: "^4.17.0" } },
      { "package-lock.json": npmLock({ weblib: "4.17.1" }) },
    );
    const out = await securityCandidates(gh, ref, config, "main");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ currentVersion: "4.17.1", latestVersion: "4.18.0" });
  });

  it("without a lockfile, a range that floats to a patched top is not flagged", async () => {
    // same advisory, but no lockfile → current = maxSatisfying = 4.20.0 (clean).
    routeOsv("weblib2", ["4.17.1", "4.20.0"], "4.20.0", { "4.17.1": ["CVE-2024-9999"] });
    const gh = ghWith({ dependencies: { weblib2: "^4.17.0" } });
    expect(await securityCandidates(gh, ref, config, "main")).toHaveLength(0);
  });

  it("targets the highest fixed version under strategy=highest", async () => {
    routeOsv("rightpad", ["2.0.0", "2.0.1", "2.1.0"], "2.1.0", { "2.0.0": ["CVE-2020-0001"] });
    const gh = ghWith({ dependencies: { rightpad: "2.0.0" } });
    const cfg = ConfigSchema.parse({ security: { strategy: "highest" } });
    const out = await securityCandidates(gh, ref, cfg, "main");
    expect(out[0]?.latestVersion).toBe("2.1.0");
  });

  it("produces nothing when the current version is not vulnerable", async () => {
    routeOsv("safepkg", ["3.0.0", "3.0.1"], "3.0.1", {}); // no vuln anywhere
    const gh = ghWith({ dependencies: { safepkg: "3.0.0" } });
    expect(await securityCandidates(gh, ref, config, "main")).toHaveLength(0);
  });

  it("produces nothing when disabled", async () => {
    routeOsv("offpkg", ["1.0.0", "1.0.1"], "1.0.1", { "1.0.0": ["GHSA-a"] });
    const gh = ghWith({ dependencies: { offpkg: "1.0.0" } });
    const cfg = ConfigSchema.parse({ security: { enabled: false } });
    expect(await securityCandidates(gh, ref, cfg, "main")).toHaveLength(0);
  });

  it("skips when no fixed version exists (all versions affected)", async () => {
    routeOsv("doomed", ["1.0.0", "1.0.1"], "1.0.1", { "1.0.0": ["GHSA-b"], "1.0.1": ["GHSA-b"] });
    const gh = ghWith({ dependencies: { doomed: "1.0.0" } });
    expect(await securityCandidates(gh, ref, config, "main")).toHaveLength(0);
  });
});
