import { describe, it, expect } from "vitest";
import { parseWorkflow, editActionRef } from "../src/adapters/github-actions/workflow.js";
import {
  pickNewerActionTag,
  actionUpdateType,
  parseActionRef,
} from "../src/adapters/github-actions/versioning.js";
import { isActionsManifest } from "../src/adapters/github-actions/index.js";

const WORKFLOW = `
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4.1.0
        with:
          node-version: 20
      - name: cache
        uses: "actions/cache@v3"
      - uses: ./.github/actions/local
      - uses: docker://alpine:3.20
      - uses: some/action@main
      - uses: pinned/action@1234567890abcdef1234567890abcdef12345678
      - uses: monorepo/tools/sub-action@v2
`;

describe("parseWorkflow", () => {
  it("extracts owner/repo@ref, skipping local/docker/branch/sha refs", () => {
    const deps = parseWorkflow(WORKFLOW);
    const names = deps.map((d) => `${d.name}@${d.range}`);
    expect(names).toContain("actions/checkout@v4");
    expect(names).toContain("actions/setup-node@v4.1.0");
    expect(names).toContain("actions/cache@v3");
    // subpath stripped to owner/repo
    expect(names).toContain("monorepo/tools@v2");
    // skipped:
    expect(names.some((n) => n.includes("local"))).toBe(false);
    expect(names.some((n) => n.includes("alpine"))).toBe(false);
    expect(names.some((n) => n.startsWith("some/action"))).toBe(false); // @main
    expect(names.some((n) => n.startsWith("pinned/action"))).toBe(false); // @sha
  });

  it("dedupes repeated action@ref", () => {
    const deps = parseWorkflow("a:\n  - uses: x/y@v1\nb:\n  - uses: x/y@v1\n");
    expect(deps).toHaveLength(1);
  });
});

describe("editActionRef", () => {
  it("rewrites the ref and preserves subpath, leaving others intact", () => {
    let out = editActionRef(WORKFLOW, "actions/checkout", "v4", "v5");
    expect(out).toContain("actions/checkout@v5");
    expect(out).toContain("actions/setup-node@v4.1.0"); // untouched
    out = editActionRef(out, "monorepo/tools", "v2", "v3");
    expect(out).toContain("monorepo/tools/sub-action@v3");
  });

  it("updates every occurrence", () => {
    const wf = "j:\n  - uses: a/b@v1\n  - uses: a/b@v1\n";
    const out = editActionRef(wf, "a/b", "v1", "v2");
    expect(out.match(/a\/b@v2/g)).toHaveLength(2);
  });

  it("throws when the ref is absent", () => {
    expect(() => editActionRef(WORKFLOW, "actions/checkout", "v9", "v10")).toThrow();
  });
});

describe("parseActionRef", () => {
  it("parses v-prefixed and bare tags with granularity", () => {
    expect(parseActionRef("v4")).toMatchObject({ major: 4, granularity: 1 });
    expect(parseActionRef("v4.1")).toMatchObject({ major: 4, minor: 1, granularity: 2 });
    expect(parseActionRef("4.1.2")).toMatchObject({ major: 4, minor: 1, patch: 2, granularity: 3 });
    expect(parseActionRef("v4-beta")).toBeNull();
    expect(parseActionRef("main")).toBeNull();
  });
});

describe("pickNewerActionTag", () => {
  const tags = ["v3", "v4", "v4.1.0", "v4.2.0", "v5", "v5.0.0", "v2.9.9"];

  it("floats a major-only ref only to a newer major tag", () => {
    expect(pickNewerActionTag("v4", tags)).toBe("v5");
    expect(pickNewerActionTag("v5", tags)).toBeNull(); // already newest major
  });

  it("bumps a pinned ref to the newest concrete tag", () => {
    expect(pickNewerActionTag("v4.1.0", tags)).toBe("v5.0.0");
    expect(pickNewerActionTag("v5.0.0", tags)).toBeNull();
  });

  it("preserves the absence of a v prefix on major floats", () => {
    expect(pickNewerActionTag("4", ["4", "5"])).toBe("5");
  });

  it("ignores pre-release / non-version tags", () => {
    expect(pickNewerActionTag("v1.0.0", ["v1.0.0", "nightly", "v1.1.0-rc.1"])).toBeNull();
  });
});

describe("actionUpdateType", () => {
  it("classifies the semver delta", () => {
    expect(actionUpdateType("v4", "v5")).toBe("major");
    expect(actionUpdateType("v4.1.0", "v4.2.0")).toBe("minor");
    expect(actionUpdateType("v4.1.0", "v4.1.1")).toBe("patch");
  });
});

describe("isActionsManifest", () => {
  it("matches workflows and composite-action files", () => {
    expect(isActionsManifest(".github/workflows/ci.yml")).toBe(true);
    expect(isActionsManifest(".github/workflows/release.yaml")).toBe(true);
    expect(isActionsManifest("sub/.github/workflows/ci.yml")).toBe(true);
    expect(isActionsManifest("action.yml")).toBe(true);
    expect(isActionsManifest("my-action/action.yaml")).toBe(true);
    expect(isActionsManifest(".github/dependabot.yml")).toBe(false);
    expect(isActionsManifest("src/workflows/ci.yml")).toBe(false);
  });
});
