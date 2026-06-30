import { describe, it, expect } from "vitest";
import { parseChart, editChartVersion } from "../src/adapters/helm/chart.js";
import { extractChartVersions } from "../src/adapters/helm/index-yaml.js";
import { bumpConstraint, currentSatisfied, latestStable, helmUpdateType } from "../src/adapters/helm/versioning.js";
import { isHelmManifest } from "../src/adapters/helm/index.js";

const CHART = `apiVersion: v2
name: my-app
version: 0.1.0
appVersion: "1.16.0"
dependencies:
  - name: postgresql
    version: "12.1.2"
    repository: https://charts.bitnami.com/bitnami
  - name: redis
    repository: https://charts.bitnami.com/bitnami
    version: ^17.0.0
  - name: common
    version: 2.2.2
    repository: file://../common
  - name: nginx
    version: 1.0.0
    repository: oci://registry.example.com/charts
`;

describe("parseChart", () => {
  it("reads http(s) chart deps regardless of field order, skips file/oci repos", () => {
    const deps = parseChart(CHART);
    const map = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(map["postgresql"]).toMatchObject({ range: "12.1.2", repository: "https://charts.bitnami.com/bitnami" });
    expect(map["redis"]).toMatchObject({ range: "^17.0.0" }); // version after repository
    expect(map["common"]).toBeUndefined(); // file://
    expect(map["nginx"]).toBeUndefined(); // oci://
  });

  it("skips dependencies missing a version or repository", () => {
    const chart = `dependencies:
  - name: novers
    repository: https://x.example.com
  - name: norepo
    version: 1.0.0
`;
    expect(parseChart(chart)).toEqual([]);
  });
});

describe("editChartVersion", () => {
  it("rewrites only the targeted chart's version (quoted)", () => {
    const out = editChartVersion(CHART, "postgresql", "12.1.2", "15.5.0");
    expect(out).toContain('version: "15.5.0"');
    expect(out).toContain("version: ^17.0.0"); // redis untouched
    expect(out).toContain('appVersion: "1.16.0"'); // not a dependency
  });

  it("rewrites an unquoted version with the field after repository", () => {
    const out = editChartVersion(CHART, "redis", "^17.0.0", "^18.0.0");
    expect(out).toContain("version: ^18.0.0");
    expect(out).toContain('version: "12.1.2"'); // postgresql untouched
  });

  it("throws when the dependency/version is absent", () => {
    expect(() => editChartVersion(CHART, "postgresql", "9.9.9", "10")).toThrow();
  });
});

const INDEX = `apiVersion: v1
entries:
  postgresql:
    - apiVersion: v2
      version: 15.5.0
      appVersion: "16.1.0"
    - apiVersion: v2
      version: 12.1.3
  redis:
    - version: 18.1.0
    - version: 17.9.0
generated: "2024-01-01T00:00:00Z"
`;

describe("extractChartVersions", () => {
  it("collects only the named chart's versions (not appVersion)", () => {
    expect(extractChartVersions(INDEX, "postgresql")).toEqual(["15.5.0", "12.1.3"]);
    expect(extractChartVersions(INDEX, "redis")).toEqual(["18.1.0", "17.9.0"]);
    expect(extractChartVersions(INDEX, "missing")).toEqual([]);
  });
});

describe("versioning", () => {
  const versions = ["12.1.2", "12.1.3", "15.5.0", "16.0.0-rc1"];
  it("finds satisfying max + stable latest", () => {
    expect(currentSatisfied("~12.1.0", versions)).toBe("12.1.3");
    expect(latestStable(versions)).toBe("15.5.0");
  });
  it("bumps preserving operator/granularity", () => {
    expect(bumpConstraint("12.1.2", "15.5.0")).toBe("15.5.0");
    expect(bumpConstraint("^17.0.0", "18.2.1")).toBe("^18.2.1");
    expect(bumpConstraint("17.x", "18.2.1")).toBe("18.x");
    expect(bumpConstraint(">= 1.0", "2.0.0")).toBeNull();
  });
  it("classifies the delta", () => {
    expect(helmUpdateType("12.1.3", "15.5.0")).toBe("major");
    expect(helmUpdateType("12.1.3", "12.2.0")).toBe("minor");
  });
});

describe("isHelmManifest", () => {
  it("matches top-level Chart.yaml, skips bundled subcharts", () => {
    expect(isHelmManifest("Chart.yaml")).toBe(true);
    expect(isHelmManifest("charts/my-app/Chart.yaml")).toBe(true); // monorepo top-level
    expect(isHelmManifest("my-app/charts/postgresql/Chart.yaml")).toBe(false); // bundled
    expect(isHelmManifest("values.yaml")).toBe(false);
  });
});
