import { describe, it, expect, vi, beforeEach } from "vitest";

// A single mutable fake GitHub client the mocked module delegates to.
const h = vi.hoisted(() => ({ gh: null as any }));

vi.mock("../src/github/client.js", () => {
  class GitHubClient {
    constructor(_token?: string) {}
    getDefaultBranch(...a: any[]) { return h.gh.getDefaultBranch(...a); }
    getFile(...a: any[]) { return h.gh.getFile(...a); }
    findManifestPaths(...a: any[]) { return h.gh.findManifestPaths(...a); }
    findManifestPathsMatching(...a: any[]) { return h.gh.findManifestPathsMatching(...a); }
    fetchSourceFiles(...a: any[]) { return h.gh.fetchSourceFiles(...a); }
    branchExists(...a: any[]) { return h.gh.branchExists(...a); }
    findOpenPr(...a: any[]) { return h.gh.findOpenPr(...a); }
    getBranchSha(...a: any[]) { return h.gh.getBranchSha(...a); }
    commitFiles(...a: any[]) { return h.gh.commitFiles(...a); }
    createPr(...a: any[]) { return h.gh.createPr(...a); }
  }
  return {
    GitHubClient,
    parseRepoRef: (s: string) => { const [owner, repo] = s.split("/"); return { owner, repo }; },
    resolveToken: () => "test-token",
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { runRun } = await import("../src/commands/run.js");

// --- helpers -----------------------------------------------------------------

function textResp(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
}
function jsonResp(obj: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
const notFound = { ok: false, status: 404, text: async () => "", json: async () => ({}) };

/** Build a fake GitHub client over a { path: content } file map. */
function mkGh(files: Record<string, string>) {
  return {
    getDefaultBranch: vi.fn(async () => "main"),
    getFile: vi.fn(async (_ref: any, path: string) =>
      path in files ? { content: files[path], sha: "sha" } : null,
    ),
    findManifestPaths: vi.fn(async (_ref: any, _base: string, filename: string) =>
      Object.keys(files).filter((p) => p.split("/").pop() === filename),
    ),
    findManifestPathsMatching: vi.fn(async (_ref: any, _base: string, pred: (p: string) => boolean) =>
      Object.keys(files).filter((p) => pred(p)),
    ),
    fetchSourceFiles: vi.fn(async () => []),
    branchExists: vi.fn(async () => false),
    findOpenPr: vi.fn(async () => null),
    getBranchSha: vi.fn(async () => "basesha"),
    commitFiles: vi.fn(async () => undefined),
    createPr: vi.fn(async () => ({ number: 1, url: "https://github.com/o/r/pull/1" })),
  };
}

const MAVEN_META = `<metadata><versioning><versions>
<version>2.15.0</version><version>2.18.0</version>
</versions></versioning></metadata>`;

const POM = (group: string, artifact: string, version: string) => `<project><dependencies>
  <dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version></dependency>
</dependencies></project>`;

const CHART = `apiVersion: v2
name: app
version: 0.1.0
dependencies:
  - name: redis
    version: "^17.0.0"
    repository: https://helm.test/charts
`;
const HELM_INDEX = `apiVersion: v1
entries:
  redis:
    - version: 18.2.0
    - version: 17.9.0
    - version: 17.0.0
`;

const RUN_OPTS = { apply: true, types: "major,minor,patch", limit: "5", token: "t" };

beforeEach(() => {
  fetchMock.mockReset();
});

// --- tests -------------------------------------------------------------------

describe("runRun — Maven (OSV-gated edit path)", () => {
  it("opens a PR through the Maven renderer when the target is safe", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    const code = await runRun("o/r", RUN_OPTS);
    expect(code).toBe(0);
    expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    const pr = h.gh.createPr.mock.calls[0][1];
    expect(pr.head).toMatch(/^converge\/maven\//);
    expect(pr.title).toBe("bump com.fasterxml.jackson.core:jackson-databind from 2.15.0 to 2.18.0");
    expect(pr.body).toContain("☕ Maven");
    // the committed pom.xml is rewritten to the new version
    const committed = h.gh.commitFiles.mock.calls[0][1].files[0].content;
    expect(committed).toContain("<version>2.18.0</version>");
  });

  it("blocks the PR when OSV reports the target as malware", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.example", "evil", "2.15.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [{ id: "MAL-2024-999" }] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    const code = await runRun("o/r", RUN_OPTS);
    expect(code).toBe(0);
    expect(h.gh.createPr).not.toHaveBeenCalled();
    expect(h.gh.commitFiles).not.toHaveBeenCalled();
  });

  it("skips when the branch already exists (idempotent)", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    h.gh.branchExists.mockResolvedValue(true);
    h.gh.findOpenPr.mockResolvedValue(7);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });

  it("does not open a PR in dry-run mode", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", { ...RUN_OPTS, apply: false });
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });
});

describe("runRun — Helm (scan-only path)", () => {
  it("opens a PR without ever consulting OSV", async () => {
    h.gh = mkGh({ "Chart.yaml": CHART });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("helm.test")) return textResp(HELM_INDEX);
      if (url.includes("api.osv.dev")) throw new Error("Helm must not query OSV");
      return notFound;
    });

    const code = await runRun("o/r", RUN_OPTS);
    expect(code).toBe(0);
    expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    const pr = h.gh.createPr.mock.calls[0][1];
    expect(pr.head).toMatch(/^converge\/helm\//);
    expect(pr.body).toContain("⎈ Helm");
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("api.osv.dev"))).toBe(true);
  });
});

describe("runRun — datasource resilience", () => {
  it("returns cleanly (no PR, no throw) when the registry errors", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.example", "fresherror", "1.0.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("maven-metadata")) return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      return notFound;
    });

    const code = await runRun("o/r", RUN_OPTS);
    expect(code).toBe(0);
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });

  it("reports no eligible updates when nothing is outdated", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.18.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("maven-metadata")) return textResp(MAVEN_META); // latest == current
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      return notFound;
    });

    const code = await runRun("o/r", RUN_OPTS);
    expect(code).toBe(0);
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });
});
