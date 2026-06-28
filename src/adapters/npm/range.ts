import semver from "semver";

/**
 * Produce a new version range that targets `toVersion` while preserving the
 * author's range style (caret, tilde, exact, or comparator).
 *
 * Examples:
 *   ^1.2.0  + 2.0.0 -> ^2.0.0
 *   ~1.2.0  + 1.3.1 -> ~1.3.1
 *   1.2.0   + 2.0.0 -> 2.0.0
 *   >=1.0.0 + 2.1.0 -> >=2.1.0
 */
export function bumpRange(range: string, toVersion: string): string {
  const trimmed = range.trim();
  if (!semver.valid(toVersion)) return range;

  // Exact pin (no operator).
  if (semver.valid(trimmed)) return toVersion;

  const m = /^(\^|~|>=|<=|>|<|=)?\s*/.exec(trimmed);
  const op = m?.[1] ?? "";
  switch (op) {
    case "^":
    case "~":
    case ">=":
    case "<=":
    case ">":
    case "<":
    case "=":
      return `${op}${toVersion}`;
    default:
      // Unusual/compound ranges: fall back to caret as a safe default.
      return `^${toVersion}`;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace a dependency's range in raw package.json text with a minimal,
 * formatting-preserving edit (Dependabot-style single-line diff).
 * Throws if the exact `"name": "oldRange"` pair is not found.
 */
export function editPackageJsonRange(
  content: string,
  name: string,
  oldRange: string,
  newRange: string,
): string {
  const re = new RegExp(
    `("${escapeRe(name)}"\\s*:\\s*")${escapeRe(oldRange)}(")`,
  );
  if (!re.test(content)) {
    throw new Error(`could not locate "${name}": "${oldRange}" in package.json`);
  }
  return content.replace(re, `$1${newRange}$2`);
}
