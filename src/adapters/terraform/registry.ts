import { log } from "../../logger.js";

const REGISTRY = process.env.CONVERGE_TF_REGISTRY ?? "https://registry.terraform.io";

const cache = new Map<string, Promise<string[]>>();

interface ProviderVersions {
  versions?: { version: string }[];
}
interface ModuleVersions {
  modules?: { versions?: { version: string }[] }[];
}

/**
 * List published versions for a Terraform registry dependency. A two-segment
 * source (`namespace/type`) is a provider; three (`namespace/name/system`) a
 * module. Metadata only; no Terraform is run. Unknown sources → empty list.
 */
export function fetchTerraformVersions(source: string): Promise<string[]> {
  const segs = source.split("/");
  let url: string;
  if (segs.length === 2) url = `${REGISTRY}/v1/providers/${source}/versions`;
  else if (segs.length === 3) url = `${REGISTRY}/v1/modules/${source}/versions`;
  else return Promise.resolve([]);

  const existing = cache.get(source);
  if (existing) return existing;

  const promise = (async (): Promise<string[]> => {
    log.debug(`GET ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`terraform registry ${res.status} for ${source}`);
    if (segs.length === 2) {
      const data = (await res.json()) as ProviderVersions;
      return (data.versions ?? []).map((v) => v.version);
    }
    const data = (await res.json()) as ModuleVersions;
    return (data.modules?.[0]?.versions ?? []).map((v) => v.version);
  })();

  cache.set(source, promise);
  return promise;
}
