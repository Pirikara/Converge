import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDockerfile, editDockerfileTag } from "../src/adapters/docker/dockerfile.js";
import { parseDockerTag, pickNewerDockerTag } from "../src/adapters/docker/versioning.js";
import { hubRepo } from "../src/adapters/docker/registry.js";
import { DockerAdapter } from "../src/adapters/docker/index.js";

describe("parseDockerfile", () => {
  it("extracts FROM image:tag; skips scratch/digest/stage/untagged", () => {
    const df = `FROM node:18-alpine AS build
FROM scratch
FROM python:3.11
FROM build
FROM ghcr.io/foo/bar@sha256:abc
FROM redis`;
    const deps = parseDockerfile(df);
    expect(deps.map((d) => `${d.name}:${d.range}`)).toEqual(["node:18-alpine", "python:3.11"]);
  });
});

describe("editDockerfileTag", () => {
  it("replaces only the matching FROM tag", () => {
    const df = `FROM node:18-alpine AS build\nFROM python:3.9\n`;
    const out = editDockerfileTag(df, "node", "18-alpine", "20-alpine");
    expect(out).toContain("FROM node:20-alpine AS build");
    expect(out).toContain("FROM python:3.9");
  });
  it("throws when the image:tag is absent", () => {
    expect(() => editDockerfileTag("FROM node:18\n", "node", "20", "22")).toThrow();
  });
});

describe("docker versioning", () => {
  it("parses tags into version + suffix + granularity", () => {
    expect(parseDockerTag("18.20.0-alpine")).toMatchObject({ version: "18.20.0", suffix: "alpine", segments: 3 });
    expect(parseDockerTag("18-bullseye-slim")).toMatchObject({ version: "18", suffix: "bullseye-slim", segments: 1 });
    expect(parseDockerTag("3.11")).toMatchObject({ version: "3.11", suffix: "", segments: 2 });
    expect(parseDockerTag("latest")).toBeNull();
  });

  it("picks newest tag with same suffix + granularity", () => {
    const tags = ["18-alpine", "20-alpine", "22-alpine", "22.1.0-alpine", "20", "22-bullseye"];
    expect(pickNewerDockerTag("18-alpine", tags)).toBe("22-alpine"); // same suffix+granularity
    expect(pickNewerDockerTag("22-alpine", tags)).toBeNull(); // already newest
  });
});

describe("hubRepo", () => {
  it("maps official vs namespaced vs non-Hub", () => {
    expect(hubRepo("node")).toBe("library/node");
    expect(hubRepo("grafana/grafana")).toBe("grafana/grafana");
    expect(hubRepo("ghcr.io/foo/bar")).toBeNull();
    expect(hubRepo("registry:5000/x")).toBeNull();
  });
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("DockerAdapter.listOutdated", () => {
  beforeEach(() => fetchMock.mockReset());
  it("flags an outdated base image tag", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ name: "18-alpine" }, { name: "20-alpine" }, { name: "22-alpine" }] }),
    });
    const adapter = new DockerAdapter();
    const manifest = adapter.parseManifestContent("FROM node:18-alpine\n", "Dockerfile", "");
    const out = await adapter.listOutdated(manifest);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("node");
    expect(out[0]!.currentVersion).toBe("18-alpine");
    expect(out[0]!.latestVersion).toBe("22-alpine");
    expect(out[0]!.updateType).toBe("major");
  });
});
