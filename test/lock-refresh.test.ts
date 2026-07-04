import { describe, it, expect } from "vitest";
import { renderLockRefreshPrBody } from "../src/core/pr-body.js";
import type { LockRefreshResult } from "../src/core/lock-refresh.js";

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
