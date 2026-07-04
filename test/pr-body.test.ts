import { describe, it, expect } from "vitest";
import { renderNugetPrBody, renderComposerPrBody, renderMavenPrBody } from "../src/core/pr-body.js";
import type { UpdateCandidate } from "../src/adapters/types.js";
import type { SafetyVerdict } from "../src/safety/types.js";

const safe: SafetyVerdict = { decision: "allow", signals: [] };

function candidate(over: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    ecosystem: "nuget",
    manifestPath: "app.csproj",
    dir: ".",
    name: "Newtonsoft.Json",
    kind: "prod",
    currentRange: "12.0.1",
    currentVersion: "12.0.1",
    latestVersion: "13.0.1",
    updateType: "major",
    ...over,
  };
}

const sec = { ids: ["GHSA-5crp-9r3c-p9vr", "CVE-2024-21907"], severity: "high" };

describe("edit-only PR bodies: security banner", () => {
  const renderers: [string, (c: UpdateCandidate) => string, Partial<UpdateCandidate>][] = [
    ["nuget", (c) => renderNugetPrBody(c, safe), { ecosystem: "nuget", manifestPath: "app.csproj" }],
    ["composer", (c) => renderComposerPrBody(c, safe), { ecosystem: "composer", manifestPath: "composer.json", name: "guzzlehttp/guzzle" }],
    ["maven", (c) => renderMavenPrBody(c, safe), { ecosystem: "maven", manifestPath: "pom.xml", name: "g:a" }],
  ];

  for (const [eco, render, over] of renderers) {
    it(`${eco}: shows the 🔒 banner with advisories when security is set`, () => {
      const body = render(candidate({ ...over, security: sec }));
      expect(body).toContain("🔒 Security fix (high)");
      expect(body).toContain("GHSA-5crp-9r3c-p9vr");
      expect(body).toContain("CVE-2024-21907");
    });

    it(`${eco}: omits the banner for a routine update`, () => {
      expect(render(candidate(over))).not.toContain("Security fix");
    });
  }
});

describe("composer PR body: lockfile note", () => {
  const c = candidate({ ecosystem: "composer", manifestPath: "composer.json", name: "guzzlehttp/guzzle" });
  it("says the lock was regenerated when lockUpdated", () => {
    const body = renderComposerPrBody(c, safe, true);
    expect(body).toContain("`composer.lock` regenerated");
    expect(body).not.toContain("run `composer update");
  });
  it("tells the user to run composer update when not", () => {
    expect(renderComposerPrBody(c, safe, false)).toContain("run `composer update");
  });
});
