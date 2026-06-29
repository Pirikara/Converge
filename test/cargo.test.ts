import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCargoToml, editCargoToml } from "../src/adapters/cargo/cargo-toml.js";
import { parseCargoLock } from "../src/audit/parsers.js";
import { CargoAdapter } from "../src/adapters/cargo/index.js";
import { findRustUsage } from "../src/impact/usage.js";

describe("parseCargoToml", () => {
  it("parses simple and table deps across sections; skips git/workspace", () => {
    const toml = `[package]
name = "demo"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }
local = { path = "../local" }
shared = { workspace = true }

[dev-dependencies]
mockall = "0.12.0"
`;
    const deps = parseCargoToml(toml);
    expect(deps.find((d) => d.name === "serde")).toMatchObject({ range: "1.0", kind: "prod" });
    expect(deps.find((d) => d.name === "tokio")).toMatchObject({ range: "1.35", kind: "prod" });
    expect(deps.find((d) => d.name === "mockall")).toMatchObject({ kind: "dev" });
    expect(deps.find((d) => d.name === "local")).toBeUndefined(); // path dep
    expect(deps.find((d) => d.name === "shared")).toBeUndefined(); // workspace dep
  });
});

describe("editCargoToml", () => {
  it("edits simple and table version forms", () => {
    expect(editCargoToml(`[dependencies]\nserde = "1.0"\n`, "serde", "1.0", "1.2.0")).toContain('serde = "1.2.0"');
    const table = `[dependencies]\ntokio = { version = "1.35", features = ["full"] }\n`;
    expect(editCargoToml(table, "tokio", "1.35", "1.40")).toContain('version = "1.40"');
  });
  it("throws when the dep/version is absent", () => {
    expect(() => editCargoToml(`[dependencies]\nserde = "1.0"\n`, "serde", "9.9", "1.2.0")).toThrow();
  });
});

describe("findRustUsage", () => {
  const files = [
    { path: "src/main.rs", content: "use serde_json::Value;\nextern crate rand;\n" },
    { path: "src/lib.rs", content: "use serde::Serialize;\n" },
  ];
  it("matches use/extern crate with hyphen->underscore", () => {
    expect(findRustUsage("serde-json", files).files).toBe(1); // serde_json in main.rs
    expect(findRustUsage("rand", files).files).toBe(1);
    expect(findRustUsage("tokio", files).files).toBe(0);
  });
});

describe("parseCargoLock", () => {
  it("enumerates [[package]] entries (direct + transitive)", () => {
    const lock = `version = 4

[[package]]
name = "bitflags"
version = "1.3.2"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "demo"
version = "0.1.0"
`;
    expect(parseCargoLock(lock)).toEqual([
      { name: "bitflags", version: "1.3.2" },
      { name: "demo", version: "0.1.0" },
    ]);
  });
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function crateDoc(name: string, max: string, nums: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      crate: { max_stable_version: max, repository: "https://github.com/x/y" },
      versions: nums.map((n) => ({ num: n, created_at: "2025-01-01T00:00:00Z", yanked: false })),
    }),
  };
}

describe("CargoAdapter.listOutdated", () => {
  beforeEach(() => fetchMock.mockReset());

  it("treats bare versions as caret (latest outside ^1 -> outdated major)", async () => {
    fetchMock.mockImplementation((url: unknown) =>
      String(url).includes("serde") ? crateDoc("serde", "2.0.0", ["1.0.0", "1.1.0", "2.0.0"]) : { ok: false, status: 404, json: async () => ({}) },
    );
    const adapter = new CargoAdapter();
    const manifest = adapter.parseManifestContent(`[dependencies]\nserde = "1.0"\n`, "Cargo.toml", "");
    const out = await adapter.listOutdated(manifest);
    expect(out).toHaveLength(1);
    expect(out[0]!.currentVersion).toBe("1.1.0"); // ^1.0 max satisfying (2.0.0 excluded)
    expect(out[0]!.latestVersion).toBe("2.0.0");
    expect(out[0]!.updateType).toBe("major");
  });
});
