import { describe, it, expect } from "vitest";
import { toOsvVuln, isMalwareAdvisory } from "../src/safety/osv.js";

describe("OSV normalisation", () => {
  it("maps GHSA severity and marks ordinary vulnerabilities", () => {
    const v = toOsvVuln({
      id: "GHSA-35jh-r3h4-6jhm",
      aliases: ["CVE-2021-23337"],
      summary: "Command Injection in lodash",
      database_specific: { severity: "HIGH" },
    });
    expect(v.severity).toBe("high");
    expect(v.malware).toBe(false);
  });

  it("flags MAL-* ids as malware", () => {
    expect(isMalwareAdvisory({ id: "MAL-2025-19452" })).toBe(true);
  });

  it("flags GitHub malware advisories (summary + malware CWE)", () => {
    // Mirrors the real ua-parser-js compromised advisory.
    expect(
      isMalwareAdvisory({
        id: "GHSA-pjwm-rvh2-c87w",
        summary: "Embedded malware in ua-parser-js",
        database_specific: { severity: "HIGH", cwe_ids: ["CWE-829", "CWE-912"] },
      }),
    ).toBe(true);
  });

  it("flags malicious-packages-origins records", () => {
    expect(
      isMalwareAdvisory({ id: "GHSA-x", database_specific: { "malicious-packages-origins": null } as never }),
    ).toBe(true);
  });

  it("does not over-match ordinary advisories", () => {
    expect(
      isMalwareAdvisory({
        id: "GHSA-29mw-wpgm-hmr9",
        summary: "Regular Expression Denial of Service (ReDoS) in lodash",
        database_specific: { severity: "MODERATE", cwe_ids: ["CWE-1333"] },
      }),
    ).toBe(false);
  });
});
