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
    updatePr(...a: any[]) { return h.gh.updatePr(...a); }
    compareBranch(...a: any[]) { return h.gh.compareBranch(...a); }
    prConflicting(...a: any[]) { return h.gh.prConflicting(...a); }
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
    updatePr: vi.fn(async () => undefined),
    compareBranch: vi.fn(async () => ({ ahead: 1, behind: 0 })),
    prConflicting: vi.fn(async () => false),
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

  it("no-ops when an open PR already targets the same version (idempotent)", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    // an existing PR whose title matches the intended one → nothing rewritten
    h.gh.findOpenPr.mockResolvedValue({
      number: 7,
      title: "bump com.fasterxml.jackson.core:jackson-databind from 2.15.0 to 2.18.0",
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).not.toHaveBeenCalled();
    expect(h.gh.commitFiles).not.toHaveBeenCalled();
    expect(h.gh.updatePr).not.toHaveBeenCalled();
  });

  it("refreshes the existing stream PR in place when the target moved", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    // an open PR on the same stream branch, but at an older target version
    h.gh.findOpenPr.mockResolvedValue({
      number: 7,
      title: "bump com.fasterxml.jackson.core:jackson-databind from 2.15.0 to 2.17.0",
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).not.toHaveBeenCalled(); // reused, not duplicated
    expect(h.gh.commitFiles).toHaveBeenCalledTimes(1); // branch force-updated
    expect(h.gh.updatePr).toHaveBeenCalledTimes(1);
    expect(h.gh.updatePr.mock.calls[0][1]).toBe(7);
    expect(h.gh.updatePr.mock.calls[0][2].title).toContain("to 2.18.0");
  });

  const SAME_TITLE = "bump com.fasterxml.jackson.core:jackson-databind from 2.15.0 to 2.18.0";

  it("rebases a behind, conflicting PR (default rebase=conflicting)", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    h.gh.findOpenPr.mockResolvedValue({ number: 7, title: SAME_TITLE });
    h.gh.compareBranch.mockResolvedValue({ ahead: 1, behind: 3 }); // behind base
    h.gh.prConflicting.mockResolvedValue(true); // and actually conflicts
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).not.toHaveBeenCalled();
    expect(h.gh.commitFiles).toHaveBeenCalledTimes(1); // rebased in place
    expect(h.gh.updatePr).toHaveBeenCalledTimes(1);
  });

  it("leaves a behind but non-conflicting PR alone (conflicting mode)", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    h.gh.findOpenPr.mockResolvedValue({ number: 7, title: SAME_TITLE });
    h.gh.compareBranch.mockResolvedValue({ ahead: 1, behind: 3 });
    h.gh.prConflicting.mockResolvedValue(false); // behind, but no conflict
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.commitFiles).not.toHaveBeenCalled();
    expect(h.gh.updatePr).not.toHaveBeenCalled();
  });

  it("never clobbers a PR a human has pushed commits to", async () => {
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    h.gh.findOpenPr.mockResolvedValue({ number: 7, title: SAME_TITLE });
    h.gh.compareBranch.mockResolvedValue({ ahead: 3, behind: 2 }); // extra human commits
    h.gh.prConflicting.mockResolvedValue(true);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.commitFiles).not.toHaveBeenCalled(); // left untouched
    expect(h.gh.updatePr).not.toHaveBeenCalled();
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });

  it("security-only mode skips routine updates", async () => {
    // maven has a routine minor update available, but security-only skips it
    // (and maven isn't in the security-fix probes) → no PR.
    h.gh = mkGh({ "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0") });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("maven-metadata")) return textResp(MAVEN_META);
      return notFound;
    });

    const code = await runRun("o/r", { ...RUN_OPTS, securityOnly: true });
    expect(code).toBe(0);
    expect(h.gh.createPr).not.toHaveBeenCalled();
  });

  it("gates routine updates by the schedule window (security still runs)", async () => {
    // converge.json restricts routine to Mondays; jackson has a routine minor.
    const files = {
      "pom.xml": POM("com.fasterxml.jackson.core", "jackson-databind", "2.15.0"),
      "converge.json": JSON.stringify({ schedule: { days: ["mon"] } }),
    };
    const osv = async (url: string) =>
      url.includes("api.osv.dev") ? jsonResp({ vulns: [] }) : url.includes("maven-metadata") ? textResp(MAVEN_META) : notFound;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Tuesday → outside the window → no routine PR
      vi.setSystemTime(new Date("2026-07-07T09:00:00Z"));
      h.gh = mkGh(files);
      fetchMock.mockImplementation(osv);
      await runRun("o/r", RUN_OPTS);
      expect(h.gh.createPr).not.toHaveBeenCalled();

      // Monday → inside the window → routine PR opens
      vi.setSystemTime(new Date("2026-07-06T09:00:00Z"));
      h.gh = mkGh(files);
      fetchMock.mockImplementation(osv);
      await runRun("o/r", RUN_OPTS);
      expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";

describe("runRun — GitHub Actions (OSV-gated, SHA pins)", () => {
  it("bumps a floating tag ref and opens a PR via the Actions renderer", async () => {
    h.gh = mkGh({ ".github/workflows/ci.yml": "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n" });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("api.github.com")) return jsonResp([{ name: "v5", commit: { sha: NEW_SHA } }, { name: "v4", commit: { sha: OLD_SHA } }]);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    const pr = h.gh.createPr.mock.calls[0][1];
    expect(pr.head).toMatch(/^converge\/github-actions\//);
    expect(pr.body).toContain("⚙️ GitHub Actions");
    expect(h.gh.commitFiles.mock.calls[0][1].files[0].content).toContain("actions/checkout@v5");
  });

  it("rewrites a SHA-pinned ref (commit SHA + comment version) end to end", async () => {
    // Distinct action name so the module-level tags cache doesn't cross tests.
    h.gh = mkGh({
      ".github/workflows/ci.yml": `jobs:\n  b:\n    steps:\n      - uses: actions/setup-node@${OLD_SHA} # v4.1.1\n`,
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("api.osv.dev")) return jsonResp({ vulns: [] });
      if (url.includes("api.github.com"))
        return jsonResp([{ name: "v4.2.0", commit: { sha: NEW_SHA } }, { name: "v4.1.1", commit: { sha: OLD_SHA } }]);
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    const committed = h.gh.commitFiles.mock.calls[0][1].files[0].content;
    expect(committed).toContain(`actions/setup-node@${NEW_SHA} # v4.2.0`);
    expect(committed).not.toContain(OLD_SHA);
  });
});

describe("runRun — Composer (constraint writeRange vs concrete version)", () => {
  it("writes the rewritten constraint while gating on the concrete version", async () => {
    h.gh = mkGh({ "composer.json": JSON.stringify({ require: { "monolog/monolog": "^2.9" } }, null, 2) });
    const osvSeen: string[] = [];
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.includes("api.osv.dev")) {
        osvSeen.push(JSON.parse(init.body).version);
        return jsonResp({ vulns: [] });
      }
      if (url.includes("packagist"))
        return jsonResp({ packages: { "monolog/monolog": [{ version: "3.5.0" }, { version: "2.9.3" }] } });
      return notFound;
    });

    await runRun("o/r", RUN_OPTS);
    expect(h.gh.createPr).toHaveBeenCalledTimes(1);
    // OSV is queried against the concrete version, not the constraint.
    expect(osvSeen).toContain("3.5.0");
    // composer.json receives the rewritten constraint (^3.5), not the concrete version.
    const committed = h.gh.commitFiles.mock.calls[0][1].files[0].content;
    expect(committed).toContain('"monolog/monolog": "^3.5"');
    expect(h.gh.createPr.mock.calls[0][1].body).toContain("🎼 Composer");
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
