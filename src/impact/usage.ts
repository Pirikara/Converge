export interface ImportSite {
  file: string;
  line: number;
  /** Imported binding names (named/default/namespace), best-effort. */
  symbols: string[];
  kind: "import" | "require" | "dynamic-import";
}

export interface UsageReport {
  pkg: string;
  /** Number of distinct files importing the package. */
  files: number;
  sites: ImportSite[];
}

export interface SourceFile {
  path: string;
  content: string;
}

const SOURCE_EXT = /\.(c|m)?[jt]sx?$|\.vue$|\.svelte$/;

export function isSourceFile(path: string): boolean {
  return SOURCE_EXT.test(path);
}

export function isPythonSourceFile(path: string): boolean {
  return /\.py$/.test(path);
}

/**
 * Candidate Python import roots for a PyPI distribution name. The distribution
 * name often differs from the import name (e.g. PyYAML→yaml), which we can't
 * fully resolve without metadata; we best-effort try the name and its
 * underscore form. Documented limitation.
 */
function pythonImportRoots(distName: string): string[] {
  const lower = distName.toLowerCase();
  return Array.from(new Set([lower, lower.replace(/-/g, "_")]));
}

/**
 * Find where a PyPI package is imported across Python source files (F3.3 for
 * pip). Matches `import pkg`, `import pkg.sub`, and `from pkg[.sub] import ...`.
 */
export function findPythonUsage(pkg: string, files: SourceFile[]): UsageReport {
  const roots = pythonImportRoots(pkg).map(escapeRe).join("|");
  const re = new RegExp(`^[ \\t]*(?:from[ \\t]+(${roots})|import[ \\t]+(${roots}))(?:[.\\s,]|$)`, "gm");

  const sites: ImportSite[] = [];
  const filesWith = new Set<string>();
  for (const f of files) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(f.content))) {
      sites.push({ file: f.path, line: lineOf(f.content, m.index), symbols: [], kind: "import" });
      filesWith.add(f.path);
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { pkg, files: filesWith.size, sites };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Parse the binding clause of an ESM import into symbol names. */
function parseSymbols(clause: string): string[] {
  const symbols: string[] = [];
  const trimmed = clause.trim();
  if (!trimmed) return symbols;

  const named = /\{([^}]*)\}/.exec(trimmed);
  if (named) {
    for (const part of named[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) symbols.push(name);
    }
  }
  const ns = /\*\s+as\s+(\w+)/.exec(trimmed);
  if (ns) symbols.push(ns[1]!);

  // Leading default import (before any "{" or "*").
  const def = /^(\w+)\s*(?:,|$)/.exec(trimmed);
  if (def && !trimmed.startsWith("{") && !trimmed.startsWith("*")) {
    symbols.unshift(def[1]!);
  }
  return symbols;
}

/**
 * Find where a package is imported across the given source files (F3.3 seed).
 * Matches ESM `import`, CommonJS `require`, and dynamic `import()` — including
 * subpath specifiers like `pkg/sub`. Best-effort regex, not a full parser.
 */
export function findUsage(pkg: string, files: SourceFile[]): UsageReport {
  const p = escapeRe(pkg);
  const spec = `['"]${p}(?:/[^'"]*)?['"]`;
  // The binding clause is identifiers/braces/commas/* only — never quotes or
  // semicolons — so the match cannot span across an earlier import statement.
  const importFrom = new RegExp(`import\\s+([\\w$\\s,{}*]+?)\\s+from\\s*${spec}`, "g");
  const bareImport = new RegExp(`import\\s*${spec}`, "g");
  const requireCall = new RegExp(`require\\(\\s*${spec}\\s*\\)`, "g");
  const dynImport = new RegExp(`import\\(\\s*${spec}\\s*\\)`, "g");

  const sites: ImportSite[] = [];
  const filesWith = new Set<string>();

  for (const f of files) {
    const c = f.content;
    let m: RegExpExecArray | null;

    importFrom.lastIndex = 0;
    while ((m = importFrom.exec(c))) {
      sites.push({ file: f.path, line: lineOf(c, m.index), symbols: parseSymbols(m[1]!), kind: "import" });
      filesWith.add(f.path);
    }
    bareImport.lastIndex = 0;
    while ((m = bareImport.exec(c))) {
      // Skip if already captured as `import ... from` (bareImport also matches the prefix).
      if (/\bfrom\b/.test(c.slice(m.index, m.index + m[0].length + 8))) continue;
      sites.push({ file: f.path, line: lineOf(c, m.index), symbols: [], kind: "import" });
      filesWith.add(f.path);
    }
    requireCall.lastIndex = 0;
    while ((m = requireCall.exec(c))) {
      sites.push({ file: f.path, line: lineOf(c, m.index), symbols: [], kind: "require" });
      filesWith.add(f.path);
    }
    dynImport.lastIndex = 0;
    while ((m = dynImport.exec(c))) {
      sites.push({ file: f.path, line: lineOf(c, m.index), symbols: [], kind: "dynamic-import" });
      filesWith.add(f.path);
    }
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { pkg, files: filesWith.size, sites };
}
