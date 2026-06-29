import { describe, it, expect } from "vitest";
import { parseCompose, editComposeImageTag } from "../src/adapters/docker/compose.js";

describe("parseCompose", () => {
  it("extracts image:tag; skips digest/var/untagged", () => {
    const yml = `services:
  web:
    image: nginx:1.21
  db:
    image: "postgres:15-alpine"
  cache:
    image: redis@sha256:abc
  app:
    image: \${REGISTRY}/app:1.0
  base:
    image: ubuntu
`;
    expect(parseCompose(yml).map((d) => `${d.name}:${d.range}`)).toEqual([
      "nginx:1.21",
      "postgres:15-alpine",
    ]);
  });
});

describe("editComposeImageTag", () => {
  it("replaces only the matching image tag", () => {
    const yml = `services:\n  web:\n    image: nginx:1.21\n  db:\n    image: postgres:15\n`;
    const out = editComposeImageTag(yml, "nginx", "1.21", "1.27");
    expect(out).toContain("image: nginx:1.27");
    expect(out).toContain("image: postgres:15");
  });
  it("throws when absent", () => {
    expect(() => editComposeImageTag("image: nginx:1.21\n", "redis", "7", "8")).toThrow();
  });
});
