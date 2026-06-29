export type NpmPackageManager = "npm" | "yarn" | "pnpm" | "bun";

/** Package managers we can currently resolve a lockfile for. */
export const RESOLVABLE_PACKAGE_MANAGERS = new Set<NpmPackageManager>(["npm"]);

export function isResolvable(pm: NpmPackageManager): boolean {
  return RESOLVABLE_PACKAGE_MANAGERS.has(pm);
}

const LOCKFILE_PM: Array<[string, NpmPackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export interface PmSignals {
  /** The `packageManager` field from package.json, if present. */
  packageManagerField?: string | null;
  /** Lockfile basenames found in the manifest directory. */
  lockfiles: string[];
}

/**
 * Decide which npm-family package manager a project uses. The `packageManager`
 * field (Corepack) is authoritative; otherwise we infer from the lockfile.
 * Defaults to npm when there is no signal.
 */
export function decidePackageManager(signals: PmSignals): NpmPackageManager {
  const field = signals.packageManagerField?.trim().toLowerCase() ?? "";
  const m = /^(pnpm|yarn|npm|bun)@/.exec(field);
  if (m) return m[1] as NpmPackageManager;

  const present = new Set(signals.lockfiles.map((l) => l.split("/").pop()));
  for (const [file, pm] of LOCKFILE_PM) {
    if (present.has(file)) return pm;
  }
  return "npm";
}
