import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseRequirements, parsePin } from "../src/adapters/pip/requirements.js";
import { PipAdapter } from "../src/adapters/pip/index.js";

describe("parseRequirements", () => {
  const content = `# --- API ---
fastapi>=0.110.0
uvicorn[standard]>=0.29.0   # ASGI server
celery[redis]>=5.4.0
langchain==1.0.8
pydantic==2.5.0 ; python_version >= "3.10"
-r dev-requirements.txt
-e .
git+https://github.com/x/y.git#egg=z
some-pkg @ https://example.com/some-pkg.whl
`;

  it("parses names, extras, specs and pins; skips options/URLs", () => {
    const reqs = parseRequirements(content);
    const names = reqs.map((r) => r.name);
    expect(names).toEqual(["fastapi", "uvicorn", "celery", "langchain", "pydantic"]);

    const uvicorn = reqs.find((r) => r.name === "uvicorn")!;
    expect(uvicorn.extras).toEqual(["standard"]);
    expect(uvicorn.range).toBe(">=0.29.0");
    expect(uvicorn.pin).toBeNull();

    const langchain = reqs.find((r) => r.name === "langchain")!;
    expect(langchain.pin).toBe("1.0.8");

    const pydantic = reqs.find((r) => r.name === "pydantic")!;
    expect(pydantic.pin).toBe("2.5.0"); // environment marker stripped
  });

  it("parsePin only matches exact == specs", () => {
    expect(parsePin("==1.0.8")).toBe("1.0.8");
    expect(parsePin(">=1.0.0")).toBeNull();
    expect(parsePin("==1.0,<2.0")).toBeNull();
  });
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function pypiDoc(version: string, versions: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      info: { version, project_urls: { Source: "https://github.com/x/y" } },
      releases: Object.fromEntries(
        versions.map((v) => [v, [{ upload_time_iso_8601: "2025-01-01T00:00:00Z", yanked: false }]]),
      ),
    }),
  };
}

describe("PipAdapter.listOutdated", () => {
  beforeEach(() => fetchMock.mockReset());

  it("flags outdated == pins and ignores range floors", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url ?? "");
      if (u.includes("langchain")) return pypiDoc("1.3.11", ["1.0.8", "1.3.11"]);
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const adapter = new PipAdapter();
    const manifest = {
      ecosystem: "pip" as const,
      path: "/r/requirements.txt",
      dir: ".",
      dependencies: parseRequirements("fastapi>=0.110.0\nlangchain==1.0.8\n"),
    };
    const out = await adapter.listOutdated(manifest);
    expect(out).toHaveLength(1); // only the langchain pin
    expect(out[0]!.name).toBe("langchain");
    expect(out[0]!.currentVersion).toBe("1.0.8");
    expect(out[0]!.latestVersion).toBe("1.3.11");
    expect(out[0]!.updateType).toBe("minor"); // 1.0.8 -> 1.3.11 keeps major 1
    expect(fetchMock).toHaveBeenCalledTimes(1); // fastapi (floor) not queried
  });

  it("does not flag a pin already at latest", async () => {
    fetchMock.mockImplementation(() => pypiDoc("2.0.0", ["1.0.0", "2.0.0"]));
    const adapter = new PipAdapter();
    const manifest = {
      ecosystem: "pip" as const,
      path: "/r/requirements.txt",
      dir: ".",
      dependencies: parseRequirements("pkg==2.0.0\n"),
    };
    expect(await adapter.listOutdated(manifest)).toHaveLength(0);
  });
});
