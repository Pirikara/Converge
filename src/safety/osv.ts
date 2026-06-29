import type { Severity } from "./types.js";
import { log } from "../logger.js";

const OSV_API = process.env.CONVERGE_OSV_API ?? "https://api.osv.dev";

export interface OsvRawVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: {
    severity?: string;
    cwe_ids?: string[];
    /** Present on advisories sourced from the malicious-packages dataset. */
    "malicious-packages-origins"?: unknown;
  };
}

export interface OsvVuln {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  malware: boolean;
  url: string;
}

function mapSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "moderate";
    case "LOW":
      return "low";
    default:
      return "info";
  }
}

// CWEs used by GitHub for malicious-code advisories.
const MALWARE_CWES = new Set(["CWE-506", "CWE-912"]);
const MALWARE_TEXT = /\b(malware|malicious package|malicious code|embedded malware|cryptominer)\b/i;

/**
 * Decide whether an OSV advisory denotes malware (vs an ordinary vulnerability).
 * Combines several signals because malware is recorded both as malicious-packages
 * MAL-* ids and as GitHub-reviewed GHSA advisories.
 */
export function isMalwareAdvisory(v: OsvRawVuln): boolean {
  const ids = [v.id, ...(v.aliases ?? [])];
  if (ids.some((x) => /^MAL-/i.test(x))) return true;
  const ds = v.database_specific ?? {};
  // The key is present (often with a null value) on malicious-packages records.
  if (Object.prototype.hasOwnProperty.call(ds, "malicious-packages-origins")) return true;
  if ((ds.cwe_ids ?? []).some((c) => MALWARE_CWES.has(c.toUpperCase()))) return true;
  if (MALWARE_TEXT.test(v.summary ?? "")) return true;
  return false;
}

/** Pure normaliser from a raw OSV record to our model (unit-tested). */
export function toOsvVuln(v: OsvRawVuln): OsvVuln {
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    summary: v.summary ?? "",
    severity: mapSeverity(v.database_specific?.severity),
    malware: isMalwareAdvisory(v),
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

/**
 * Batch-query OSV for many package versions at once (`/v1/querybatch`). Returns,
 * per input (same order), the advisory ids affecting it (empty when clean).
 * Used to audit a whole lockfile tree cheaply before fetching full details.
 */
export async function queryOsvBatch(
  ecosystem: string,
  items: { name: string; version: string }[],
): Promise<string[][]> {
  const results: string[][] = [];
  const CHUNK = 1000;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const res = await fetch(`${OSV_API}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: chunk.map((it) => ({ package: { name: it.name, ecosystem }, version: it.version })),
      }),
    });
    if (!res.ok) throw new Error(`OSV batch ${res.status}`);
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    for (const r of data.results ?? []) results.push((r.vulns ?? []).map((v) => v.id));
  }
  return results;
}

const cache = new Map<string, Promise<OsvVuln[]>>();

/**
 * Query OSV.dev for advisories affecting a specific package version.
 * Covers both known vulnerabilities and known-malware advisories —
 * Converge's deterministic F2.1 layer.
 */
export function queryOsv(
  ecosystem: string,
  name: string,
  version: string,
): Promise<OsvVuln[]> {
  const key = `${ecosystem}/${name}@${version}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<OsvVuln[]> => {
    const res = await fetch(`${OSV_API}/v1/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, package: { name, ecosystem } }),
    });
    if (!res.ok) throw new Error(`OSV ${res.status} for ${key}`);
    const data = (await res.json()) as { vulns?: OsvRawVuln[] };
    const vulns = (data.vulns ?? []).map(toOsvVuln);
    log.debug(`OSV ${key}: ${vulns.length} advisor${vulns.length === 1 ? "y" : "ies"}`);
    return vulns;
  })();

  cache.set(key, promise);
  return promise;
}
