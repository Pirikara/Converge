import { z } from "zod";

/**
 * converge.json schema. Mirrors SPEC §9.
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
        cargo: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        docker: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        "github-actions": z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        terraform: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        nuget: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        composer: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        helm: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
        maven: z
          .object({
            enabled: z.boolean().default(true),
            directories: z.array(z.string()).default([]),
          })
          .default({}),
      })
      .default({}),
    schedule: z.string().default("weekly"),
    // How far to move a dependency (Converge's own vocabulary; independent of
    // any other tool). "latest": bump to the registry's latest, replacing the
    // range if needed (may cross a major). "in-range": only move up within the
    // declared range — never crossing its major — so e.g. "^3.23.8" advances to
    // "^3.25.76" but not "^4.x". Currently honoured by the npm ecosystem.
    updateStrategy: z.enum(["latest", "in-range"]).default("latest"),
    // How to keep open update PRs current when the base branch moves (Converge's
    // own vocabulary). "conflicting": rebase only PRs that actually conflict with
    // base; "behind": rebase any PR whose branch fell behind base; "never": don't
    // auto-rebase. A PR a human has pushed extra commits to is never rebased.
    rebase: z.enum(["conflicting", "behind", "never"]).default("conflicting"),
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
    // Bundle related updates into a single PR. Each group has a name and a list
    // of name patterns (exact, or `*` wildcard). Converge's own schema.
    groups: z
      .array(
        z.object({
          name: z.string(),
          match: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/** Fully-defaulted config (used when no file is present). */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
