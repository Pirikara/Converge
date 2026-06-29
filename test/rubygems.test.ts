import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseGemfile, gemPin } from "../src/adapters/rubygems/gemfile.js";
import { RubyGemsAdapter } from "../src/adapters/rubygems/index.js";

const GEMFILE = `source "https://rubygems.org"

gem "rails", "7.0.0"
gem 'puma', '~> 6.0'
gem "rspec"
gem "pg", ">= 1.1", "< 2.0"
gem "mygem", git: "https://github.com/x/mygem"

group :development do
  gem "rubocop", "1.50.0"
end
`;

describe("parseGemfile", () => {
  it("captures gems, requirements and pins; skips git gems", () => {
    const gems = parseGemfile(GEMFILE);
    expect(gems.map((g) => g.name)).toEqual(["rails", "puma", "rspec", "pg", "rubocop"]);
    expect(gems.find((g) => g.name === "rails")?.pin).toBe("7.0.0");
    expect(gems.find((g) => g.name === "puma")?.pin).toBeNull(); // ~> range
    expect(gems.find((g) => g.name === "rspec")?.range).toBe(""); // no constraint
    expect(gems.find((g) => g.name === "pg")?.pin).toBeNull(); // compound
    expect(gems.find((g) => g.name === "rubocop")?.pin).toBe("1.50.0");
  });

  it("gemPin only matches exact versions", () => {
    expect(gemPin("7.0.0")).toBe("7.0.0");
    expect(gemPin("= 7.0.0")).toBe("7.0.0");
    expect(gemPin("~> 7.0")).toBeNull();
    expect(gemPin(">= 1.1, < 2.0")).toBeNull();
  });
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function gemsJson(version: string) {
  return { ok: true, status: 200, json: async () => ({ version, source_code_uri: "https://github.com/x/y" }) };
}
function versionsJson(numbers: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => numbers.map((n) => ({ number: n, created_at: "2024-01-01T00:00:00Z", prerelease: /[a-z]/i.test(n) })),
  };
}

describe("RubyGemsAdapter.listOutdated", () => {
  beforeEach(() => fetchMock.mockReset());

  it("flags outdated exact pins, ignores ranges/constraint-less gems", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("/gems/rails")) return gemsJson("7.1.3");
      if (u.includes("/versions/rails")) return versionsJson(["7.0.0", "7.1.3"]);
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const adapter = new RubyGemsAdapter();
    const manifest = adapter.parseManifestContent(GEMFILE, "Gemfile", "");
    const out = await adapter.listOutdated(manifest);

    // Only rails (7.0.0) and rubocop (1.50.0) are exact pins; rubocop 404s here.
    expect(out.map((c) => c.name)).toEqual(["rails"]);
    expect(out[0]!.currentVersion).toBe("7.0.0");
    expect(out[0]!.latestVersion).toBe("7.1.3");
    expect(out[0]!.updateType).toBe("minor");
  });
});
