import { describe, it, expect, vi } from "vitest";
import { parseNpmLockTree } from "../src/audit/lockfile-npm.js";
import { auditPackages, type AuditDeps } from "../src/audit/audit.js";
import type { OsvVuln } from "../src/safety/osv.js";

describe("parseNpmLockTree", () => {
  it("enumerates direct + transitive from lockfileVersion 3 packages", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/lodash": { version: "4.17.15" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/b": { version: "2.0.0" }, // nested transitive
        frontend: {}, // workspace entry, no node_modules -> skipped
      },
    });
    const tree = parseNpmLockTree(lock);
    expect(tree).toEqual([
      { name: "lodash", version: "4.17.15" },
      { name: "a", version: "1.0.0" },
      { name: "b", version: "2.0.0" }, // ← transitive, present only in the lockfile
    ]);
  });

  it("dedupes repeated name@version and supports v1 nested tree", () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } },
        c: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } }, // dup b
      },
    });
    const tree = parseNpmLockTree(lock);
    expect(tree.filter((p) => p.name === "b")).toHaveLength(1);
  });
});

function vuln(over: Partial<OsvVuln>): OsvVuln {
  return { id: "GHSA-x", aliases: [], summary: "", severity: "high", malware: false, url: "", ...over };
}

describe("auditPackages", () => {
  it("flags transitive malware/vulns and marks direct vs transitive", async () => {
    const tree = [
      { name: "lodash", version: "4.17.15" },
      { name: "evil", version: "1.0.0" },
      { name: "clean", version: "1.0.0" },
    ];
    const deps: AuditDeps = {
      batch: vi.fn(async () => [["GHSA-1"], ["MAL-1"], []]), // lodash vuln, evil malware, clean none
      query: vi.fn(async (_eco, name) =>
        name === "evil"
          ? [vuln({ id: "MAL-1", malware: true, severity: "critical" })]
          : [vuln({ id: "GHSA-1", severity: "high" })],
      ),
    };
    const findings = await auditPackages("npm", tree, new Set(["lodash"]), deps);

    expect(findings).toHaveLength(2);
    // malware sorts first
    expect(findings[0]!.name).toBe("evil");
    expect(findings[0]!.direct).toBe(false); // transitive (not in directs set)
    expect(findings[0]!.vulns[0]!.malware).toBe(true);
    expect(findings[1]!.name).toBe("lodash");
    expect(findings[1]!.direct).toBe(true);
    expect(deps.query).toHaveBeenCalledTimes(2); // only the two with batch hits
  });
});
