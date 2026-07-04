import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseGoMod } from "../src/adapters/gomod/gomod.js";
import { escapeModulePath } from "../src/adapters/gomod/proxy.js";
import { GoAdapter } from "../src/adapters/gomod/index.js";
import { pruneStaleZipHash } from "../src/resolve/go-cli.js";

const GOMOD = `module example.com/me

go 1.21

require (
\tgithub.com/pkg/errors v0.9.0
\tgolang.org/x/sync v0.5.0 // indirect
)

require github.com/spf13/cobra v1.7.0
`;

describe("parseGoMod", () => {
  it("parses block + single-line requires and marks indirect", () => {
    const reqs = parseGoMod(GOMOD);
    expect(reqs.map((r) => r.name)).toEqual([
      "github.com/pkg/errors",
      "golang.org/x/sync",
      "github.com/spf13/cobra",
    ]);
    expect(reqs.find((r) => r.name === "golang.org/x/sync")?.indirect).toBe(true);
    expect(reqs.find((r) => r.name === "github.com/pkg/errors")?.indirect).toBe(false);
    expect(reqs.find((r) => r.name === "github.com/pkg/errors")?.range).toBe("v0.9.0");
  });
});

describe("escapeModulePath", () => {
  it("escapes uppercase letters with !", () => {
    expect(escapeModulePath("github.com/Azure/azure-sdk-for-go")).toBe(
      "github.com/!azure/azure-sdk-for-go",
    );
    expect(escapeModulePath("github.com/pkg/errors")).toBe("github.com/pkg/errors");
  });
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function latest(version: string) {
  return { ok: true, status: 200, json: async () => ({ Version: version, Time: "2024-01-01T00:00:00Z" }) };
}
function list(versions: string[]) {
  return { ok: true, status: 200, text: async () => versions.join("\n") };
}

describe("GoAdapter.listOutdated", () => {
  beforeEach(() => fetchMock.mockReset());

  it("flags outdated direct modules and skips indirect ones", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("errors") && u.includes("@latest")) return latest("v0.9.1");
      if (u.includes("errors") && u.includes("@v/list")) return list(["v0.9.0", "v0.9.1"]);
      if (u.includes("cobra") && u.includes("@latest")) return latest("v1.7.0");
      if (u.includes("cobra") && u.includes("@v/list")) return list(["v1.7.0"]);
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    });

    const adapter = new GoAdapter();
    const manifest = adapter.parseManifestContent(GOMOD, "go.mod", "");
    const out = await adapter.listOutdated(manifest);

    expect(out).toHaveLength(1); // errors outdated; cobra current; x/sync indirect (skipped)
    expect(out[0]!.name).toBe("github.com/pkg/errors");
    expect(out[0]!.currentVersion).toBe("v0.9.0");
    expect(out[0]!.latestVersion).toBe("v0.9.1");
    expect(out[0]!.updateType).toBe("patch");
  });
});

describe("pruneStaleZipHash", () => {
  const m = "golang.org/x/sys";
  const before = [
    `${m} v0.42.0 h1:OLDZIP=`,
    `${m} v0.42.0/go.mod h1:SHARED=`,
    `${m} v0.44.0 h1:NEWZIP=`,
    `${m} v0.44.0/go.mod h1:SHARED=`,
    "example.com/other v1.0.0 h1:X=",
    "",
  ].join("\n");

  it("drops only the old version's zip line, keeping its go.mod hash", () => {
    const out = pruneStaleZipHash(before, m, "v0.42.0", "v0.44.0");
    expect(out).not.toContain(`${m} v0.42.0 h1:OLDZIP=`);
    expect(out).toContain(`${m} v0.42.0/go.mod h1:SHARED=`); // MVS may still need it
    expect(out).toContain(`${m} v0.44.0 h1:NEWZIP=`);
    expect(out).toContain("example.com/other v1.0.0 h1:X="); // untouched
  });

  it("is a no-op when the new version's zip line is absent (guard)", () => {
    const noNew = `${m} v0.42.0 h1:OLDZIP=\n${m} v0.42.0/go.mod h1:S=\n`;
    expect(pruneStaleZipHash(noNew, m, "v0.42.0", "v0.44.0")).toBe(noNew);
  });

  it("does not touch a different module at the same version", () => {
    const s = `other/x v0.42.0 h1:KEEP=\n${m} v0.42.0 h1:OLD=\n${m} v0.44.0 h1:NEW=\n`;
    const out = pruneStaleZipHash(s, m, "v0.42.0", "v0.44.0");
    expect(out).toContain("other/x v0.42.0 h1:KEEP=");
    expect(out).not.toContain(`${m} v0.42.0 h1:OLD=`);
  });
});
