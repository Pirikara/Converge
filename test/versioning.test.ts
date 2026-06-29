import { describe, it, expect } from "vitest";
import { getVersioning } from "../src/versioning/index.js";

const semver = getVersioning("semver");
const pep440 = getVersioning("pep440");
const go = getVersioning("go");

describe("semver versioning", () => {
  it("compares, classifies, and picks max satisfying", () => {
    expect(semver.diff("1.2.0", "2.0.0")).toBe("major");
    expect(semver.diff("1.2.0", "1.3.0")).toBe("minor");
    expect(semver.isStable("1.0.0")).toBe(true);
    expect(semver.isStable("1.0.0-rc.1")).toBe(false);
    expect(semver.maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], "^1.0.0")).toBe("1.2.0");
  });
});

describe("pep440 versioning", () => {
  it("orders post / pre / dev / final correctly (semver.coerce got these wrong)", () => {
    expect(pep440.compare("1.0", "1.0.post1")).toBe(-1); // post is newer
    expect(pep440.compare("1.0a1", "1.0")).toBe(-1); // pre is older
    expect(pep440.compare("1.0.dev1", "1.0a1")).toBe(-1); // dev oldest
    expect(pep440.compare("1.0", "1.0.0")).toBe(0); // trailing zeros equal
    expect(pep440.compare("1!1.0", "2.0")).toBe(1); // epoch dominates
    expect(pep440.isGreaterThan("1.0.post1", "1.0")).toBe(true);
  });

  it("classifies real PyPI bumps", () => {
    expect(pep440.diff("1.0.8", "1.3.11")).toBe("minor");
    expect(pep440.diff("1.0.8", "2.0.0")).toBe("major");
    expect(pep440.diff("0.4.1", "0.4.2")).toBe("patch");
    expect(pep440.diff("1.0.8", "1.0.8")).toBe("none");
  });

  it("knows stability (post is stable, pre/dev are not)", () => {
    expect(pep440.isStable("2.0.0")).toBe(true);
    expect(pep440.isStable("2.0.0.post1")).toBe(true);
    expect(pep440.isStable("2.0.0rc1")).toBe(false);
    expect(pep440.isStable("2.0.0.dev3")).toBe(false);
  });

  it("supports specifiers incl. compatible-release (~=)", () => {
    expect(pep440.satisfies("1.4.3", ">=1.4.2")).toBe(true);
    expect(pep440.satisfies("1.4.1", ">=1.4.2")).toBe(false);
    expect(pep440.satisfies("1.4.5", "~=1.4.2")).toBe(true);
    expect(pep440.satisfies("1.5.0", "~=1.4.2")).toBe(false);
    expect(pep440.satisfies("2.0.0", ">=1.0,<2.0")).toBe(false);
  });
});

describe("go versioning (semver with leading v)", () => {
  it("tolerates the v prefix", () => {
    expect(go.isValid("v1.2.3")).toBe(true);
    expect(go.diff("v1.2.0", "v2.0.0")).toBe("major");
    expect(go.compare("v1.2.0", "v1.10.0")).toBe(-1);
  });
});
