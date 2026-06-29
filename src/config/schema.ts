import { z } from "zod";

/**
 * safebump.json schema. Mirrors SPEC §9.
 * Repository-side config; all fields optional with sane defaults.
 */
export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    ecosystems: z
      .object({
        npm: z
          .object({
            enabled: z.boolean().default(true),
            // Directories (relative to repo root) to scan. Empty = auto-discover.
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        pip: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        gomod: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        rubygems: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
      })
      .default({}),
    schedule: z.string().default("weekly"),
    safety: z
      .object({
        cooldownDays: z.number().int().min(0).default(3),
        cooldownOverrideForCVE: z.boolean().default(true),
        onSuspicious: z.enum(["block", "warn", "hold"]).default("hold"),
        onKnownMalware: z.enum(["block", "warn", "hold"]).default("block"),
        allow: z
          .array(z.object({ pkg: z.string(), version: z.string() }))
          .default([]),
      })
      .default({}),
    resolution: z
      .object({
        allowRangeWidening: z.boolean().default(true),
        groupRelated: z.boolean().default(true),
      })
      .default({}),
    impact: z
      .object({
        runTests: z.boolean().default(true),
        mapUsageSites: z.boolean().default(true),
      })
      .default({}),
    updates: z
      .object({
        autoMerge: z
          .object({
            enabled: z.boolean().default(false),
            when: z.string().default("risk:low AND safety:safe AND tests:pass"),
          })
          .default({}),
      })
      .default({}),
    deprecation: z
      .object({ openIssues: z.boolean().default(false) })
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/** Fully-defaulted config (used when no file is present). */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
