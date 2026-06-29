import { describe, it, expect } from "vitest";
import { parsePyproject } from "../src/adapters/pyproject/parse.js";
import { parseTomlLockPackages } from "../src/audit/parsers.js";

describe("parsePyproject", () => {
  it("parses PEP 621 dependencies (array of PEP 508 strings)", () => {
    const toml = `[project]
name = "demo"
dependencies = [
    "flask>=2.0",
    "requests==2.28.0",
    "click~=8.1",
]
`;
    const deps = parsePyproject(toml);
    expect(deps.find((d) => d.name === "flask")).toMatchObject({ range: ">=2.0", pin: null });
    expect(deps.find((d) => d.name === "requests")).toMatchObject({ pin: "2.28.0" });
    expect(deps.find((d) => d.name === "click")?.pin).toBeNull();
  });

  it("parses Poetry tables and skips python", () => {
    const toml = `[tool.poetry.dependencies]
python = "^3.10"
flask = "2.0.0"
requests = { version = "2.28.0", optional = true }
`;
    const deps = parsePyproject(toml);
    expect(deps.find((d) => d.name === "python")).toBeUndefined();
    // Poetry bare "2.0.0" means caret (^2.0.0), so it is NOT an exact pin
    expect(deps.find((d) => d.name === "flask")).toMatchObject({ range: "2.0.0", pin: null });
    expect(deps.find((d) => d.name === "requests")).toMatchObject({ range: "2.28.0" });
  });
});

describe("parseTomlLockPackages (poetry.lock / uv.lock)", () => {
  it("enumerates [[package]] name/version (direct + transitive)", () => {
    const lock = `[[package]]
name = "flask"
version = "2.0.0"

[[package]]
name = "werkzeug"
version = "2.0.3"
`;
    expect(parseTomlLockPackages(lock)).toEqual([
      { name: "flask", version: "2.0.0" },
      { name: "werkzeug", version: "2.0.3" },
    ]);
  });
});
