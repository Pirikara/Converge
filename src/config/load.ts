import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigSchema, defaultConfig, type Config } from "./schema.js";
import { log } from "../logger.js";

const CONFIG_FILENAMES = ["safebump.json", "safebump.json5", ".safebumprc.json"];

/**
 * Strip JSON5-style comments so users can annotate config (SPEC §9).
 * Handles // line and /* block *\/ comments outside of strings.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += input[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the file used, or null when defaults were applied. */
  source: string | null;
}

/** Load and validate repository config, falling back to defaults. */
export async function loadConfig(repoRoot: string): Promise<LoadedConfig> {
  for (const name of CONFIG_FILENAMES) {
    const filePath = path.join(repoRoot, name);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      throw new Error(`${name}: invalid JSON — ${(err as Error).message}`);
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new Error(`${name}: invalid config\n${issues}`);
    }
    log.debug(`loaded config from ${name}`);
    return { config: result.data, source: filePath };
  }
  log.debug("no config file found; using defaults");
  return { config: defaultConfig(), source: null };
}
