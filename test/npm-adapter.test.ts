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
    dir = await mkdtemp(path.join(tmpdir(), "converge-"));
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

  describe("in-range strategy", () => {
    let n = 0;
    // fetchPackageMeta caches by name, so each call uses a fresh package name.
    async function outdated(range: string, versions: string[], latest: string, strategy?: "latest" | "in-range") {
      const name = `pkg-${n++}`;
      const file = path.join(dir, "package.json");
      await writeFile(file, JSON.stringify({ dependencies: { [name]: range } }));
      fetchMock.mockResolvedValueOnce(packument(name, versions, latest));
      const adapter = new NpmAdapter(strategy);
      return adapter.listOutdated(await adapter.parseManifest(file, dir));
    }

    it("stays within the major and bumps the range floor (not to a new major)", async () => {
      const vs = ["3.23.8", "3.25.76", "4.0.0", "4.4.3"];
      // latest mode jumps to 4.4.3 (major); in-range stops at the top of 3.x.
      expect((await outdated("^3.23.8", vs, "4.4.3", "latest"))[0]).toMatchObject({
        latestVersion: "4.4.3",
        updateType: "major",
      });
      const [c] = await outdated("^3.23.8", vs, "4.4.3", "in-range");
      expect(c).toMatchObject({
        currentRange: "^3.23.8",
        currentVersion: "3.23.8", // the range floor
        latestVersion: "3.25.76", // highest in-range
        updateType: "minor",
      });
    });

    it("produces no update when the floor is already the top of the major", async () => {
      // latest 4.0.0 is a major ahead and there is no newer 3.x → nothing in-range.
      const out = await outdated("^3.23.8", ["3.23.8", "4.0.0"], "4.0.0", "in-range");
      expect(out).toHaveLength(0);
    });

    it("leaves an exact pin untouched (no in-range headroom)", async () => {
      const out = await outdated("3.23.8", ["3.23.8", "3.25.0"], "3.25.0", "in-range");
      expect(out).toHaveLength(0);
    });
  });
});
