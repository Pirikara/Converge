import { describe, it, expect } from "vitest";
import { stripJsonComments } from "../src/config/load.js";
import { ConfigSchema, defaultConfig } from "../src/config/schema.js";

describe("stripJsonComments", () => {
  it("removes line and block comments outside strings", () => {
    const input = `{
      // a line comment
      "schedule": "weekly", /* inline */
      "url": "http://example.com" // trailing
    }`;
    const out = JSON.parse(stripJsonComments(input));
    expect(out.schedule).toBe("weekly");
    expect(out.url).toBe("http://example.com");
  });

  it("preserves // inside string values", () => {
    const out = JSON.parse(stripJsonComments(`{ "u": "a//b" }`));
    expect(out.u).toBe("a//b");
  });
});

describe("ConfigSchema", () => {
  it("applies defaults for an empty object", () => {
    const c = defaultConfig();
    expect(c.safety.cooldownDays).toBe(3);
    expect(c.safety.onKnownMalware).toBe("block");
    expect(c.updates.autoMerge.enabled).toBe(false);
    expect(c.ecosystems.npm.enabled).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const r = ConfigSchema.safeParse({ bogus: true });
    expect(r.success).toBe(false);
  });

  it("rejects invalid enum values", () => {
    const r = ConfigSchema.safeParse({ safety: { onSuspicious: "nope" } });
    expect(r.success).toBe(false);
  });
});
