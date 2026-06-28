import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveUpdate, type ResolveDeps } from "../src/resolve/ladder.js";
import type { NpmRunResult } from "../src/resolve/npm-cli.js";

const ERESOLVE_STDERR = `npm error code ERESOLVE
npm error Found: react@19.0.0
npm error peer react@"^18.0.0" from @testing-library/react@13.4.0`;

const ok: NpmRunResult = { ok: true, code: 0, stdout: "", stderr: "" };
const eresolve: NpmRunResult = { ok: false, code: 1, stdout: "", stderr: ERESOLVE_STDERR };

describe("resolveUpdate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "safebump-ladder-"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          dependencies: { react: "^18.2.0" },
          devDependencies: { "@testing-library/react": "^13.0.0" },
        },
        null,
        2,
      ),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves directly when the lockfile regenerates cleanly", async () => {
    const deps: ResolveDeps = {
      resolveLockfile: vi.fn(async () => ok),
      findPeerCompatibleVersion: vi.fn(async () => null),
    };
    const out = await resolveUpdate(
      { workdir: dir, name: "react", fromRange: "^18.2.0", toRange: "^18.3.0" },
      deps,
    );
    expect(out.status).toBe("resolved");
    const pkg = await readFile(path.join(dir, "package.json"), "utf8");
    expect(pkg).toContain('"react": "^18.3.0"');
  });

  it("auto co-bumps the conflicting peer package on ERESOLVE", async () => {
    const resolveLockfile = vi
      .fn<(d: string) => Promise<NpmRunResult>>()
      .mockResolvedValueOnce(eresolve) // direct fails
      .mockResolvedValueOnce(ok); // co-bump succeeds
    const deps: ResolveDeps = {
      resolveLockfile,
      findPeerCompatibleVersion: vi.fn(async () => "16.1.0"),
    };
    const out = await resolveUpdate(
      { workdir: dir, name: "react", fromRange: "^18.2.0", toRange: "^19.0.0" },
      deps,
    );
    expect(out.status).toBe("resolved-cobump");
    if (out.status !== "unsolvable") {
      expect(out.changes).toHaveLength(2);
      const cobump = out.changes.find((c) => c.cobump);
      expect(cobump?.name).toBe("@testing-library/react");
      expect(cobump?.toRange).toBe("^16.1.0");
    }
    const pkg = await readFile(path.join(dir, "package.json"), "utf8");
    expect(pkg).toContain('"react": "^19.0.0"');
    expect(pkg).toContain('"@testing-library/react": "^16.1.0"');
  });

  it("reports unsolvable with the parsed conflict when no co-bump exists", async () => {
    const deps: ResolveDeps = {
      resolveLockfile: vi.fn(async () => eresolve),
      findPeerCompatibleVersion: vi.fn(async () => null),
    };
    const out = await resolveUpdate(
      { workdir: dir, name: "react", fromRange: "^18.2.0", toRange: "^19.0.0" },
      deps,
    );
    expect(out.status).toBe("unsolvable");
    if (out.status === "unsolvable") {
      expect(out.conflict?.from?.name).toBe("@testing-library/react");
      expect(out.attempted.some((a) => a.startsWith("co-bump"))).toBe(true);
    }
  });
});
