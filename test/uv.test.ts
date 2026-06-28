import { describe, it, expect } from "vitest";
import { classifyUvFailure, extractUvExplanation } from "../src/resolve/uv-cli.js";

// Captured from uv 0.11 output during the spike.
const CONFLICT = `  × No solution found when resolving dependencies:
  ╰─▶ Because langchain==1.3.11 depends on pydantic>=2.7.4,<3.0.0 and
      you require langchain==1.3.11, we can conclude that you require
      pydantic>=2.7.4,<3.0.0.
      And because you require pydantic==1.10.0, we can conclude that your
      requirements are unsatisfiable.`;

const NEEDS_BUILD = `  × No solution found when resolving dependencies:
  ╰─▶ Because jsonpath-ng==1.5.0 has no usable wheels and you require
      jsonpath-ng==1.5.0, we can conclude that your requirements are unsatisfiable.

      hint: Wheels are required for \`jsonpath-ng\` because building from source
      is disabled for all packages (i.e., with \`--no-build\`)`;

describe("classifyUvFailure", () => {
  it("classifies a version conflict", () => {
    expect(classifyUvFailure(CONFLICT)).toBe("conflict");
  });

  it("classifies a source-only package as needs-build (even though it also says 'No solution')", () => {
    expect(classifyUvFailure(NEEDS_BUILD)).toBe("needs-build");
  });

  it("falls back to error for unrecognised output", () => {
    expect(classifyUvFailure("network unreachable")).toBe("error");
  });
});

describe("extractUvExplanation", () => {
  it("strips uv's box-drawing characters into readable text", () => {
    const out = extractUvExplanation(CONFLICT);
    expect(out).toContain("Because langchain==1.3.11 depends on pydantic>=2.7.4,<3.0.0");
    expect(out).not.toContain("╰");
    expect(out).not.toContain("×");
  });
});
