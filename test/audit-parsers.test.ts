import { describe, it, expect } from "vitest";
import { parsePnpmLock, parseYarnLock, parseGoSum, parseGemfileLock } from "../src/audit/parsers.js";

describe("parsePnpmLock", () => {
  it("extracts package keys incl. scoped + peer-suffixed", () => {
    const lock = `lockfileVersion: '9.0'

packages:

  accepts@1.3.8:
    resolution: {integrity: sha512-x}

  '@babel/core@7.0.0(supports-color@8.0.0)':
    resolution: {integrity: sha512-y}

  body-parser@1.20.0:
    resolution: {integrity: sha512-z}`;
    const t = parsePnpmLock(lock);
    expect(t).toContainEqual({ name: "accepts", version: "1.3.8" });
    expect(t).toContainEqual({ name: "@babel/core", version: "7.0.0" });
    expect(t).toContainEqual({ name: "body-parser", version: "1.20.0" });
  });
});

describe("parseYarnLock", () => {
  it("handles Berry npm: descriptors and resolved versions", () => {
    const lock = `"@babel/core@npm:^7.0.0":
  version: 7.0.0

lodash@npm:^4.17.0:
  version: 4.17.21`;
    const t = parseYarnLock(lock);
    expect(t).toContainEqual({ name: "@babel/core", version: "7.0.0" });
    expect(t).toContainEqual({ name: "lodash", version: "4.17.21" });
  });
});

describe("parseGoSum", () => {
  it("extracts modules (dedup h1 + /go.mod) with v stripped", () => {
    const sum = `github.com/pkg/errors v0.9.1 h1:aaa=
github.com/pkg/errors v0.9.1/go.mod h1:bbb=
github.com/gin-gonic/gin v1.4.0 h1:ccc=`;
    const t = parseGoSum(sum);
    expect(t).toEqual([
      { name: "github.com/pkg/errors", version: "0.9.1" },
      { name: "github.com/gin-gonic/gin", version: "1.4.0" },
    ]);
  });
});

describe("parseGemfileLock", () => {
  it("reads specs (all) and DEPENDENCIES (direct)", () => {
    const lock = `GEM
  remote: https://rubygems.org/
  specs:
    rack (3.1.0)
    actionpack (7.0.0)
      rack (>= 2.0)

PLATFORMS
  ruby

DEPENDENCIES
  rack (= 3.1.0)
`;
    const { packages, directs } = parseGemfileLock(lock);
    expect(packages).toEqual([
      { name: "rack", version: "3.1.0" },
      { name: "actionpack", version: "7.0.0" },
    ]);
    expect(directs.has("rack")).toBe(true);
    expect(directs.has("actionpack")).toBe(false);
  });
});
