import { describe, it, expect } from "vitest";
import { parseComposerJson, editComposerConstraint } from "../src/adapters/composer/manifest.js";
import {
  composerConstraintToRange,
  bumpConstraint,
  currentSatisfied,
  latestStable,
  composerUpdateType,
} from "../src/adapters/composer/versioning.js";
import { isComposerManifest } from "../src/adapters/composer/index.js";
import { parseComposerLock } from "../src/audit/parsers.js";

const COMPOSER_JSON = JSON.stringify(
  {
    name: "acme/app",
    require: {
      php: ">=8.1",
      "ext-mbstring": "*",
      "monolog/monolog": "^2.9",
      "guzzlehttp/guzzle": "~7.4",
      "symfony/console": "6.3.*",
    },
    "require-dev": {
      "phpunit/phpunit": "10.5.1",
    },
  },
  null,
  2,
);

describe("parseComposerJson", () => {
  it("reads require + require-dev, skipping platform requirements", () => {
    const deps = parseComposerJson(COMPOSER_JSON);
    const map = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(map["monolog/monolog"]).toMatchObject({ range: "^2.9", kind: "prod" });
    expect(map["phpunit/phpunit"]).toMatchObject({ range: "10.5.1", kind: "dev" });
    expect(map["php"]).toBeUndefined();
    expect(map["ext-mbstring"]).toBeUndefined();
  });
});

describe("editComposerConstraint", () => {
  it("rewrites only the targeted package constraint", () => {
    const out = editComposerConstraint(COMPOSER_JSON, "monolog/monolog", "^2.9", "^3.0");
    expect(out).toContain('"monolog/monolog": "^3.0"');
    expect(out).toContain('"guzzlehttp/guzzle": "~7.4"'); // untouched
  });

  it("throws when the constraint is absent", () => {
    expect(() => editComposerConstraint(COMPOSER_JSON, "monolog/monolog", "^9.9", "^10")).toThrow();
  });
});

describe("composerConstraintToRange", () => {
  it("maps caret/tilde/wildcard/exact and OR", () => {
    expect(composerConstraintToRange("^2.9")).toBe("^2.9");
    expect(composerConstraintToRange("~7.4")).toBe("^7.4"); // 2-seg tilde widens like caret
    expect(composerConstraintToRange("~7.4.1")).toBe("~7.4.1"); // 3-seg tilde
    expect(composerConstraintToRange("6.3.*")).toBe("6.3.x");
    expect(composerConstraintToRange("1.2.3")).toBe("=1.2.3");
    expect(composerConstraintToRange(">=1.0 <2.0")).toBe(">=1.0 <2.0");
    expect(composerConstraintToRange("^1.0 || ^2.0")).toBe("^1.0 || ^2.0");
    expect(composerConstraintToRange("dev-main")).toBeNull();
  });
});

describe("currentSatisfied / latestStable", () => {
  const versions = ["2.9.1", "2.9.3", "3.0.0", "3.5.0", "4.0.0-RC1"];
  it("finds the constraint-satisfying max and ignores prereleases for latest", () => {
    expect(currentSatisfied("^2.9", versions)).toBe("2.9.3");
    expect(latestStable(versions)).toBe("3.5.0");
  });
});

describe("bumpConstraint", () => {
  it("preserves operator/granularity, declines multi-term", () => {
    expect(bumpConstraint("^2.9", "3.5.0")).toBe("^3.5");
    expect(bumpConstraint("~7.4.1", "8.2.0")).toBe("~8.2.0");
    expect(bumpConstraint("6.3.*", "7.1.0")).toBe("7.1.*");
    expect(bumpConstraint("1.2.3", "1.5.0")).toBe("1.5.0");
    expect(bumpConstraint(">=1.0 <2.0", "3.0.0")).toBeNull();
  });
});

describe("composerUpdateType", () => {
  it("classifies the delta", () => {
    expect(composerUpdateType("2.9.3", "3.5.0")).toBe("major");
    expect(composerUpdateType("7.4.0", "7.5.0")).toBe("minor");
  });
});

describe("parseComposerLock", () => {
  it("flattens packages + packages-dev and strips leading v", () => {
    const lock = JSON.stringify({
      packages: [
        { name: "monolog/monolog", version: "2.9.3" },
        { name: "guzzlehttp/guzzle", version: "v7.8.1" },
      ],
      "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.1" }],
    });
    const pkgs = parseComposerLock(lock);
    expect(pkgs).toContainEqual({ name: "monolog/monolog", version: "2.9.3" });
    expect(pkgs).toContainEqual({ name: "guzzlehttp/guzzle", version: "7.8.1" }); // v stripped
    expect(pkgs).toContainEqual({ name: "phpunit/phpunit", version: "10.5.1" });
  });

  it("returns [] on malformed JSON", () => {
    expect(parseComposerLock("{not json")).toEqual([]);
  });

  it("is wired into the audit lockfile dispatch as Packagist", async () => {
    const { parseLockfile } = await import("../src/audit/lockfiles.js");
    const lock = JSON.stringify({ packages: [{ name: "a/b", version: "1.0.0" }] });
    expect(parseLockfile("composer.lock", lock)).toEqual({
      ecosystem: "Packagist",
      packages: [{ name: "a/b", version: "1.0.0" }],
    });
  });
});

describe("isComposerManifest", () => {
  it("matches composer.json outside vendor/", () => {
    expect(isComposerManifest("composer.json")).toBe(true);
    expect(isComposerManifest("packages/api/composer.json")).toBe(true);
    expect(isComposerManifest("vendor/monolog/monolog/composer.json")).toBe(false);
    expect(isComposerManifest("composer.lock")).toBe(false);
  });
});
