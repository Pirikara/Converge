import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NpmAdapter } from "../src/adapters/npm/index.js";

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
      time: Object.fromEntries(versions.map((v) => [v, "2024-01-01T00:00:00Z"])),
    }),
  };
}

describe("NpmAdapter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "safebump-"));
    fetchMock.mockReset();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses dependencies across all blocks", async () => {
    const file = path.join(dir, "package.json");
    await writeFile(
      file,
      JSON.stringify({
        dependencies: { left: "^1.0.0" },
        devDependencies: { vitest: "^2.0.0" },
        peerDependencies: { react: "^18.0.0" },
      }),
    );
    const m = await new NpmAdapter().parseManifest(file, dir);
    expect(m.dependencies).toHaveLength(3);
    expect(m.dependencies.find((d) => d.name === "react")?.kind).toBe("peer");
  });

  it("flags an outdated dependency with the right update type", async () => {
    const file = path.join(dir, "package.json");
    await writeFile(file, JSON.stringify({ dependencies: { left: "^1.0.0" } }));
    fetchMock.mockResolvedValueOnce(
      packument("left", ["1.0.0", "1.2.0", "2.0.0"], "2.0.0"),
    );
    const adapter = new NpmAdapter();
    const m = await adapter.parseManifest(file, dir);
    const out = await adapter.listOutdated(m);
    expect(out).toHaveLength(1);
    expect(out[0]!.currentVersion).toBe("1.2.0");
    expect(out[0]!.latestVersion).toBe("2.0.0");
    expect(out[0]!.updateType).toBe("major");
  });

  it("ignores unresolvable ranges (workspace/file/*)", async () => {
    const file = path.join(dir, "package.json");
    await writeFile(
      file,
      JSON.stringify({
        dependencies: { a: "workspace:*", b: "file:../b", c: "*" },
      }),
    );
    const adapter = new NpmAdapter();
    const m = await adapter.parseManifest(file, dir);
    const out = await adapter.listOutdated(m);
    expect(out).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not flag a dependency already at latest", async () => {
    const file = path.join(dir, "package.json");
    await writeFile(file, JSON.stringify({ dependencies: { left: "^2.0.0" } }));
    fetchMock.mockResolvedValueOnce(
      packument("left", ["1.0.0", "2.0.0"], "2.0.0"),
    );
    const adapter = new NpmAdapter();
    const m = await adapter.parseManifest(file, dir);
    const out = await adapter.listOutdated(m);
    expect(out).toHaveLength(0);
  });
});
