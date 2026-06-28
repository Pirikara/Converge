import { describe, it, expect } from "vitest";
import { parseEresolve, splitNameVersion, describeConflict } from "../src/resolve/conflict.js";

const NPM11_ERESOLVE = `npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: fixture@1.0.0
npm error Found: react@19.0.0
npm error node_modules/react
npm error   react@"19.0.0" from the root project
npm error
npm error Could not resolve dependency:
npm error peer react@"^18.0.0" from @testing-library/react@13.4.0
npm error node_modules/@testing-library/react
npm error   @testing-library/react@"13.4.0" from the root project`;

describe("splitNameVersion", () => {
  it("handles scoped and unscoped packages", () => {
    expect(splitNameVersion("react@19.0.0")).toEqual({ name: "react", version: "19.0.0" });
    expect(splitNameVersion("@testing-library/react@13.4.0")).toEqual({
      name: "@testing-library/react",
      version: "13.4.0",
    });
  });
});

describe("parseEresolve", () => {
  it("extracts found, peer, and the imposing package from npm 11 output", () => {
    const c = parseEresolve(NPM11_ERESOLVE);
    expect(c.found).toEqual({ name: "react", version: "19.0.0" });
    expect(c.peer).toEqual({ name: "react", range: "^18.0.0" });
    expect(c.from).toEqual({ name: "@testing-library/react", version: "13.4.0" });
  });

  it("describes the conflict for humans", () => {
    const c = parseEresolve(NPM11_ERESOLVE);
    expect(describeConflict(c)).toContain("@testing-library/react@13.4.0 requires peer react");
  });

  it("returns nulls for unrecognised text", () => {
    const c = parseEresolve("some other npm failure");
    expect(c.found).toBeNull();
    expect(c.peer).toBeNull();
  });
});
