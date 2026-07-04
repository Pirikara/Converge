import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderLockRefreshPrBody } from "../src/core/pr-body.js";
import { diffLocks, highest, securityFixed, vetNewVersions, type LockRefreshResult } from "../src/core/lock-refresh.js";
import { ConfigSchema } from "../src/config/schema.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const jsonResp = (obj: unknown) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => "" };

function npmLock(pkgs: Record<string, string>) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(Object.entries(pkgs).map(([n, v]) => [`node_modules/${n}`, { version: v }])),
  });
}
const composerLock = (pkgs: Record<string, string>) =>
  JSON.stringify({ packages: Object.entries(pkgs).map(([name, version]) => ({ name, version })), "packages-dev": [] });
const cargoLock = (pkgs: Record<string, string>) =>
  "version = 3\n" + Object.entries(pkgs).map(([n, v]) => `\n[[package]]\nname = "${n}"\nversion = "${v}"\n`).join("");
const gemfileLock = (specs: Record<string, string>) =>
  "GEM\n  remote: https://rubygems.org/\n  specs:\n" +
  Object.entries(specs).map(([n, v]) => `    ${n} (${v})\n`).join("") +
  "\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n";
const uvLock = (pkgs: Record<string, string>) =>
  "version = 1\n" + Object.entries(pkgs).map(([n, v]) => `\n[[package]]\nname = "${n}"\nversion = "${v}"\n`).join("");
const yarnLock = (pkgs: Record<string, string>) =>
  "__metadata:\n  version: 8\n" +
  Object.entries(pkgs)
    .map(([n, v]) => `\n"${n}@npm:${v}":\n  version: ${v}\n  resolution: "${n}@npm:${v}"\n  languageName: node\n  linkType: hard\n`)
    .join("");
// bun.lock is JSONC with trailing commas — the fixture keeps them on purpose.
const bunLock = (pkgs: Record<string, string>) =>
  '{\n  "lockfileVersion": 1,\n  "packages": {\n' +
  Object.entries(pkgs).map(([n, v]) => `    "${n}": ["${n}@${v}", "", {}, "sha512-x"],\n`).join("") +
  "  }\n}\n";

function result(over: Partial<LockRefreshResult> = {}): LockRefreshResult {
  return {
    ecosystem: "composer",
    dir: ".",
    lockPath: "composer.lock",
    files: [{ path: "composer.lock", content: "…" }],
    changed: [
      { name: "guzzlehttp/guzzle", from: "7.4.0", to: "7.13.1" },
      { name: "symfony/deprecation-contracts", from: "2.5.4", to: "3.7.1" },
    ],
    securityFixed: [{ name: "guzzlehttp/guzzle", from: "7.4.0", to: "7.13.1", ids: ["CVE-2022-31090"] }],
    blocked: [],
    warnings: [],
    ...over,
  };
}

describe("renderLockRefreshPrBody", () => {
  it("states it regenerated within ranges with no manifest change", () => {
    const body = renderLockRefreshPrBody(result());
    expect(body).toContain("lockfile refresh");
    expect(body).toContain("no manifest change, no overrides");
    expect(body).toContain("2 package(s)");
  });

  it("surfaces the security fixes with advisory links", () => {
    const body = renderLockRefreshPrBody(result());
    expect(body).toContain("Fixes 1 known vulnerability");
    expect(body).toContain("`guzzlehttp/guzzle` 7.4.0 → 7.13.1");
    expect(body).toContain("osv.dev/vulnerability/CVE-2022-31090");
  });

  it("omits the vulnerability section when nothing is fixed", () => {
    const body = renderLockRefreshPrBody(result({ securityFixed: [] }));
    expect(body).not.toContain("known vulnerabilit");
    expect(body).toContain("Updated packages");
  });

  it("truncates a long package list", () => {
    const changed = Array.from({ length: 25 }, (_, i) => ({ name: `pkg-${i}`, from: "1.0.0", to: "1.1.0" }));
    const body = renderLockRefreshPrBody(result({ changed, securityFixed: [] }));
    expect(body).toContain("first 20 of 25");
  });
});

describe("highest", () => {
  it("orders numerically, not lexically", () => {
    expect(highest(["1.2.0", "1.10.0", "1.9.0"])).toBe("1.10.0");
    expect(highest(["0.6.0", "0.44.0", "0.42.0"])).toBe("0.44.0");
  });
  it("handles Go v-prefixed versions", () => {
    expect(highest(["v0.6.0", "v0.42.0", "v0.44.0"])).toBe("v0.44.0");
  });
});

describe("diffLocks", () => {
  it("reports npm packages whose locked version changed, ignoring unchanged", () => {
    const oldC = npmLock({ left: "1.0.0", stable: "2.0.0" });
    const newC = npmLock({ left: "1.2.0", stable: "2.0.0" });
    const changed = diffLocks("package-lock.json", oldC, newC);
    expect(changed).toEqual([{ name: "left", from: "1.0.0", to: "1.2.0" }]);
  });

  it("reports composer package version changes", () => {
    const changed = diffLocks(
      "composer.lock",
      composerLock({ "guzzlehttp/guzzle": "7.4.0" }),
      composerLock({ "guzzlehttp/guzzle": "7.13.1" }),
    );
    expect(changed).toEqual([{ name: "guzzlehttp/guzzle", from: "7.4.0", to: "7.13.1" }]);
  });

  it("collapses go.sum's multiple entries per module to one highest→highest change", () => {
    const oldSum = [
      "golang.org/x/sys v0.6.0/go.mod h1:aaa=",
      "golang.org/x/sys v0.42.0 h1:bbb=",
      "golang.org/x/sys v0.42.0/go.mod h1:ccc=",
      "other/pkg v1.0.0 h1:ddd=",
      "other/pkg v1.0.0/go.mod h1:eee=",
      "",
    ].join("\n");
    const newSum = [
      "golang.org/x/sys v0.6.0/go.mod h1:aaa=",
      "golang.org/x/sys v0.44.0 h1:fff=",
      "golang.org/x/sys v0.44.0/go.mod h1:ggg=",
      "other/pkg v1.0.0 h1:ddd=",
      "other/pkg v1.0.0/go.mod h1:eee=",
      "",
    ].join("\n");
    // parseGoSum strips the `v` prefix and dedupes; the diff collapses x/sys's
    // {0.6.0, 0.42.0} → {0.6.0, 0.44.0} to a single highest→highest change.
    const changed = diffLocks("go.sum", oldSum, newSum);
    expect(changed).toEqual([{ name: "golang.org/x/sys", from: "0.42.0", to: "0.44.0" }]);
  });

  it("ignores packages present only in the new lock", () => {
    const changed = diffLocks("package-lock.json", npmLock({ a: "1.0.0" }), npmLock({ a: "1.0.0", b: "2.0.0" }));
    expect(changed).toEqual([]);
  });

  it("reports Cargo.lock crate version changes", () => {
    const changed = diffLocks(
      "Cargo.lock",
      cargoLock({ openssl: "0.10.75", keep: "1.0.0" }),
      cargoLock({ openssl: "0.10.81", keep: "1.0.0" }),
    );
    expect(changed).toEqual([{ name: "openssl", from: "0.10.75", to: "0.10.81" }]);
  });

  it("reports Gemfile.lock gem version changes", () => {
    const changed = diffLocks(
      "Gemfile.lock",
      gemfileLock({ rack: "2.2.0", nokogiri: "1.16.0" }),
      gemfileLock({ rack: "2.2.23", nokogiri: "1.16.0" }),
    );
    expect(changed).toEqual([{ name: "rack", from: "2.2.0", to: "2.2.23" }]);
  });

  it("reports uv.lock package version changes", () => {
    const changed = diffLocks(
      "uv.lock",
      uvLock({ jinja2: "3.1.2", click: "8.1.0" }),
      uvLock({ jinja2: "3.1.6", click: "8.1.0" }),
    );
    expect(changed).toEqual([{ name: "jinja2", from: "3.1.2", to: "3.1.6" }]);
  });

  it("reports yarn.lock package version changes", () => {
    const changed = diffLocks(
      "yarn.lock",
      yarnLock({ "is-odd": "3.0.0", left: "1.0.0" }),
      yarnLock({ "is-odd": "3.0.1", left: "1.0.0" }),
    );
    expect(changed).toEqual([{ name: "is-odd", from: "3.0.0", to: "3.0.1" }]);
  });

  it("reports bun.lock package version changes (JSONC with trailing commas)", () => {
    const changed = diffLocks(
      "bun.lock",
      bunLock({ "is-odd": "3.0.0", left: "1.0.0" }),
      bunLock({ "is-odd": "3.0.1", left: "1.0.0" }),
    );
    expect(changed).toEqual([{ name: "is-odd", from: "3.0.0", to: "3.0.1" }]);
  });
});

describe("securityFixed", () => {
  beforeEach(() => fetchMock.mockReset());

  // vulnAt maps OSV-form version → advisory ids affecting it.
  function routeOsv(vulnAt: Record<string, string[]>) {
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (typeof url !== "string") return notFound;
      if (url.includes("/v1/querybatch")) {
        const { queries } = JSON.parse(init!.body!) as { queries: { version: string }[] };
        return jsonResp({ results: queries.map((q) => ({ vulns: (vulnAt[q.version] ?? []).map((id) => ({ id })) })) });
      }
      if (url.includes("/v1/query")) {
        const { version } = JSON.parse(init!.body!) as { version: string };
        return jsonResp({ vulns: (vulnAt[version] ?? []).map((id) => ({ id })) });
      }
      return notFound;
    });
  }

  it("flags a change that moves off an affected version, not a clean one", async () => {
    routeOsv({ "7.4.0": ["CVE-2022-31090"] }); // 7.13.1 and others are clean
    const fixed = await securityFixed("composer", [
      { name: "guzzlehttp/guzzle", from: "7.4.0", to: "7.13.1" },
      { name: "clean/pkg", from: "1.0.0", to: "1.1.0" },
    ]);
    expect(fixed).toEqual([{ name: "guzzlehttp/guzzle", from: "7.4.0", to: "7.13.1", ids: ["CVE-2022-31090"] }]);
  });

  it("does not flag when the advisory still affects the new version", async () => {
    routeOsv({ "1.0.0": ["GHSA-x"], "1.1.0": ["GHSA-x"] }); // unresolved
    expect(await securityFixed("npm", [{ name: "pkg", from: "1.0.0", to: "1.1.0" }])).toEqual([]);
  });

  it("queries OSV with the v-stripped version for Go", async () => {
    const asked: string[] = [];
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (typeof url !== "string") return notFound;
      if (url.includes("/v1/querybatch")) {
        const { queries } = JSON.parse(init!.body!) as { queries: { version: string }[] };
        queries.forEach((q) => asked.push(q.version));
        return jsonResp({ results: queries.map((q) => ({ vulns: q.version === "1.0.0" ? [{ id: "GO-1" }] : [] })) });
      }
      if (url.includes("/v1/query")) {
        const { version } = JSON.parse(init!.body!) as { version: string };
        asked.push(version);
        return jsonResp({ vulns: version === "1.0.0" ? [{ id: "GO-1" }] : [] });
      }
      return notFound;
    });
    const fixed = await securityFixed("gomod", [{ name: "x/y", from: "v1.0.0", to: "v1.2.0" }]);
    expect(fixed[0]?.ids).toEqual(["GO-1"]);
    expect(asked.every((v) => !v.startsWith("v"))).toBe(true); // v stripped for OSV
  });
});

describe("vetNewVersions", () => {
  beforeEach(() => fetchMock.mockReset());
  const policy = ConfigSchema.parse({}).safety;

  // advisoriesAt maps version → raw OSV advisory records the new version carries.
  function routeVet(advisoriesAt: Record<string, unknown[]>) {
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (typeof url !== "string") return notFound;
      if (url.includes("/v1/querybatch")) {
        const { queries } = JSON.parse(init!.body!) as { queries: { version: string }[] };
        return jsonResp({ results: queries.map((q) => ({ vulns: (advisoriesAt[q.version] ?? []).map((a) => ({ id: (a as { id: string }).id })) })) });
      }
      if (url.includes("/v1/query")) {
        const { version } = JSON.parse(init!.body!) as { version: string };
        return jsonResp({ vulns: advisoriesAt[version] ?? [] });
      }
      return notFound;
    });
  }

  it("blocks a refresh whose new version is malware", async () => {
    routeVet({ "2.0.0": [{ id: "MAL-2024-1", summary: "malicious code" }] });
    const { blocked } = await vetNewVersions(policy, "npm", [{ name: "evil", from: "1.0.0", to: "2.0.0" }]);
    expect(blocked).toEqual([{ name: "evil", version: "2.0.0", reason: "malware", ids: ["MAL-2024-1"] }]);
  });

  it("blocks a new version with a high/critical vulnerability", async () => {
    routeVet({ "2.0.0": [{ id: "GHSA-hi", database_specific: { severity: "HIGH" } }] });
    const { blocked } = await vetNewVersions(policy, "npm", [{ name: "highpkg", from: "1.0.0", to: "2.0.0" }]);
    expect(blocked[0]).toMatchObject({ name: "highpkg", version: "2.0.0", reason: "vulnerability" });
  });

  it("warns (does not block) on a lower-severity advisory", async () => {
    routeVet({ "2.0.0": [{ id: "GHSA-lo", database_specific: { severity: "LOW" } }] });
    const { blocked, warnings } = await vetNewVersions(policy, "npm", [{ name: "lowpkg", from: "1.0.0", to: "2.0.0" }]);
    expect(blocked).toEqual([]);
    expect(warnings[0]).toContain("GHSA-lo");
  });

  it("passes a clean new version", async () => {
    routeVet({});
    const out = await vetNewVersions(policy, "npm", [{ name: "cleanpkg", from: "1.0.0", to: "2.0.0" }]);
    expect(out).toEqual({ blocked: [], warnings: [] });
  });
});
