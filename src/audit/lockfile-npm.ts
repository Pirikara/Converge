export interface LockPackage {
  name: string;
  version: string;
}

/** Extract the package name from a package-lock v2/v3 `packages` key. */
function nameFromKey(key: string): string | null {
  const idx = key.lastIndexOf("node_modules/");
  if (idx === -1) return null; // root or workspace entry
  return key.slice(idx + "node_modules/".length);
}

/**
 * Enumerate ALL resolved packages (direct + transitive) from a package-lock.json.
 * Supports lockfileVersion 2/3 (`packages` map) and falls back to v1
 * (`dependencies` tree). Returns unique name@version pairs.
 */
export function parseNpmLockTree(content: string): LockPackage[] {
  const lock = JSON.parse(content) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
  };
  const seen = new Set<string>();
  const out: LockPackage[] = [];
  const add = (name: string | null, version: string | undefined): void => {
    if (!name || !version) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, version });
  };

  if (lock.packages) {
    for (const [k, v] of Object.entries(lock.packages)) {
      add(nameFromKey(k), v.version);
    }
  } else if (lock.dependencies) {
    // v1: recurse the nested dependencies tree.
    const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>): void => {
      for (const [name, info] of Object.entries(deps)) {
        add(name, info.version);
        if (info.dependencies) walk(info.dependencies as typeof deps);
      }
    };
    walk(lock.dependencies);
  }
  return out;
}
