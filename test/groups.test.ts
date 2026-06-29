import { describe, it, expect } from "vitest";
import { matchesPattern, partitionGroups } from "../src/core/groups.js";
import type { UpdateCandidate } from "../src/adapters/types.js";

function c(
  name: string,
  opts: { ecosystem?: string; dir?: string } = {},
): UpdateCandidate {
  return {
    name,
    ecosystem: opts.ecosystem ?? "npm",
    dir: opts.dir ?? ".",
    currentRange: "^1.0.0",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateType: "major",
  } as UpdateCandidate;
}

describe("matchesPattern", () => {
  it("matches exact names", () => {
    expect(matchesPattern("eslint", "eslint")).toBe(true);
    expect(matchesPattern("eslint", "prettier")).toBe(false);
  });

  it("matches prefix wildcards", () => {
    expect(matchesPattern("@types/node", "@types/*")).toBe(true);
    expect(matchesPattern("@types/react", "@types/*")).toBe(true);
    expect(matchesPattern("react", "@types/*")).toBe(false);
  });

  it("matches infix/suffix wildcards", () => {
    expect(matchesPattern("eslint-plugin-import", "eslint-*")).toBe(true);
    expect(matchesPattern("babel-jest", "*-jest")).toBe(true);
    expect(matchesPattern("vitest", "*-jest")).toBe(false);
  });

  it("does not let `*` escape dots in a literal", () => {
    expect(matchesPattern("axyz", "a.c")).toBe(false);
  });
});

describe("partitionGroups", () => {
  it("returns everything individual when no rules", () => {
    const cs = [c("a"), c("b")];
    const { groups, individual } = partitionGroups(cs, []);
    expect(groups).toHaveLength(0);
    expect(individual).toHaveLength(2);
  });

  it("buckets matching deps into a named group", () => {
    const cs = [c("@types/node"), c("@types/react"), c("react")];
    const { groups, individual } = partitionGroups(cs, [
      { name: "types", match: ["@types/*"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("types");
    expect(groups[0]!.candidates.map((x) => x.name)).toEqual([
      "@types/node",
      "@types/react",
    ]);
    expect(individual.map((x) => x.name)).toEqual(["react"]);
  });

  it("degrades a group of one to individual", () => {
    const cs = [c("@types/node"), c("react")];
    const { groups, individual } = partitionGroups(cs, [
      { name: "types", match: ["@types/*"] },
    ]);
    expect(groups).toHaveLength(0);
    expect(individual.map((x) => x.name).sort()).toEqual(["@types/node", "react"]);
  });

  it("never combines across ecosystem or directory", () => {
    const cs = [
      c("eslint", { dir: "frontend" }),
      c("eslint-plugin-import", { dir: "backend" }),
    ];
    const { groups, individual } = partitionGroups(cs, [
      { name: "lint", match: ["eslint*"] },
    ]);
    // different dirs → two buckets of one each → both degrade to individual
    expect(groups).toHaveLength(0);
    expect(individual).toHaveLength(2);
  });

  it("groups same ecosystem+dir, splits different dirs", () => {
    const cs = [
      c("eslint", { dir: "frontend" }),
      c("eslint-plugin-import", { dir: "frontend" }),
      c("eslint", { dir: "backend" }),
      c("eslint-config-x", { dir: "backend" }),
    ];
    const { groups } = partitionGroups(cs, [{ name: "lint", match: ["eslint*"] }]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.candidates.length === 2)).toBe(true);
  });

  it("first matching rule wins", () => {
    const cs = [c("eslint")];
    const { groups, individual } = partitionGroups(
      [...cs, c("eslint-plugin-x")],
      [
        { name: "lint", match: ["eslint*"] },
        { name: "everything", match: ["*"] },
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("lint");
    expect(individual).toHaveLength(0);
  });
});
