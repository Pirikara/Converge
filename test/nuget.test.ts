import { describe, it, expect } from "vitest";
import { parseCsproj, editPackageReference } from "../src/adapters/nuget/csproj.js";
import {
  parseNuGetVersion,
  compareNuGet,
  maxStableNuGet,
  nugetUpdateType,
  isStable,
} from "../src/adapters/nuget/versioning.js";
import { isNuGetManifest } from "../src/adapters/nuget/index.js";

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Version="3.1.1" Include="Serilog" />
    <PackageReference Include="AutoMapper">
      <Version>12.0.0</Version>
    </PackageReference>
    <PackageReference Include="LocalProj" />
  </ItemGroup>
</Project>`;

const CPM = `<Project>
  <ItemGroup>
    <PackageVersion Include="xunit" Version="2.6.1" />
  </ItemGroup>
</Project>`;

describe("parseCsproj", () => {
  it("reads Version attribute in either order and nested <Version>", () => {
    const map = Object.fromEntries(parseCsproj(CSPROJ).map((d) => [d.name, d.range]));
    expect(map["Newtonsoft.Json"]).toBe("13.0.1");
    expect(map["Serilog"]).toBe("3.1.1"); // Version before Include
    expect(map["AutoMapper"]).toBe("12.0.0"); // nested element
    expect(map["LocalProj"]).toBeUndefined(); // no version
  });

  it("reads Central Package Management PackageVersion", () => {
    expect(parseCsproj(CPM)).toEqual([{ name: "xunit", range: "2.6.1", kind: "prod" }]);
  });
});

describe("editPackageReference", () => {
  it("rewrites only the targeted package (attribute form)", () => {
    const out = editPackageReference(CSPROJ, "Newtonsoft.Json", "13.0.1", "13.0.3");
    expect(out).toContain('Include="Newtonsoft.Json" Version="13.0.3"');
    expect(out).toContain('Version="3.1.1" Include="Serilog"'); // untouched
  });

  it("rewrites the reversed-attribute form", () => {
    const out = editPackageReference(CSPROJ, "Serilog", "3.1.1", "3.2.0");
    expect(out).toContain('Version="3.2.0" Include="Serilog"');
  });

  it("rewrites the nested <Version> element", () => {
    const out = editPackageReference(CSPROJ, "AutoMapper", "12.0.0", "13.0.1");
    expect(out).toContain("<Version>13.0.1</Version>");
  });

  it("throws when the package/version is absent", () => {
    expect(() => editPackageReference(CSPROJ, "Newtonsoft.Json", "9.9.9", "10")).toThrow();
  });
});

describe("parseNuGetVersion / compareNuGet", () => {
  it("parses 2–4 part versions and prereleases", () => {
    expect(parseNuGetVersion("1.2.3")).toEqual({ parts: [1, 2, 3], pre: [] });
    expect(parseNuGetVersion("1.2.3.4")).toEqual({ parts: [1, 2, 3, 4], pre: [] });
    expect(parseNuGetVersion("1.2.3-beta.1")).toEqual({ parts: [1, 2, 3], pre: ["beta", "1"] });
    expect(parseNuGetVersion("1.2.3+abc")).toEqual({ parts: [1, 2, 3], pre: [] }); // build dropped
    expect(parseNuGetVersion("1")).toBeNull();
    expect(parseNuGetVersion("not-a-version")).toBeNull();
  });

  it("orders releases above prereleases and respects part precedence", () => {
    expect(compareNuGet("1.2.3", "1.2.3-beta") > 0).toBe(true);
    expect(compareNuGet("1.2.3-beta.2", "1.2.3-beta.10") < 0).toBe(true);
    expect(compareNuGet("2.0.0", "1.9.9") > 0).toBe(true);
    expect(compareNuGet("1.2.3.4", "1.2.3") > 0).toBe(true);
  });
});

describe("maxStableNuGet", () => {
  it("ignores prereleases", () => {
    expect(maxStableNuGet(["1.0.0", "2.0.0-rc1", "1.5.0"])).toBe("1.5.0");
    expect(maxStableNuGet(["2.0.0-rc1"])).toBeNull();
    expect(isStable("2.0.0-rc1")).toBe(false);
  });
});

describe("nugetUpdateType", () => {
  it("classifies the delta", () => {
    expect(nugetUpdateType("13.0.1", "14.0.0")).toBe("major");
    expect(nugetUpdateType("13.0.1", "13.1.0")).toBe("minor");
    expect(nugetUpdateType("13.0.1", "13.0.3")).toBe("patch");
    expect(nugetUpdateType("1.2.3.4", "1.2.3.5")).toBe("patch");
  });
});

describe("isNuGetManifest", () => {
  it("matches project files and CPM props", () => {
    expect(isNuGetManifest("src/App/App.csproj")).toBe(true);
    expect(isNuGetManifest("Lib.fsproj")).toBe(true);
    expect(isNuGetManifest("Thing.vbproj")).toBe(true);
    expect(isNuGetManifest("Directory.Packages.props")).toBe(true);
    expect(isNuGetManifest("Directory.Build.props")).toBe(false);
    expect(isNuGetManifest("appsettings.json")).toBe(false);
  });
});
