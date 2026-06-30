import type { DependencyEntry } from "../types.js";

interface PomDep {
  name: string;
  version: string;
  vStart: number;
  vEnd: number;
}

function tag(body: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(body);
  return m ? m[1]! : null;
}

/** Blank out `<!-- … -->` comments, preserving length (and newlines) so offsets hold. */
function maskComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Find `<dependency>` entries with a literal `<version>`, tracking value offsets. */
function findPomDeps(content: string): PomDep[] {
  const out: PomDep[] = [];
  const masked = maskComments(content);
  const block = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(masked))) {
    const body = m[1]!;
    const bodyStart = m.index + "<dependency>".length;
    const group = tag(body, "groupId");
    const artifact = tag(body, "artifactId");
    if (!group || !artifact) continue;
    const vm = /<version>\s*([^<]+?)\s*<\/version>/.exec(body);
    if (!vm) continue; // managed elsewhere (BOM / dependencyManagement)
    const version = vm[1]!;
    if (version.includes("${")) continue; // property reference — not bumped in v1
    const valueStart = bodyStart + vm.index + vm[0].indexOf(version);
    out.push({ name: `${group}:${artifact}`, version, vStart: valueStart, vEnd: valueStart + version.length });
  }
  return out;
}

/** Parse Maven dependencies (group:artifact + literal version) from a pom.xml. */
export function parsePom(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  for (const d of findPomDeps(content)) {
    const key = `${d.name}@${d.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: d.name, range: d.version, kind: "prod" });
  }
  return out;
}

/** Replace the literal `<version>` of `group:artifact` (currently `from`) with `to`. */
export function editPomVersion(content: string, name: string, from: string, to: string): string {
  for (const d of findPomDeps(content)) {
    if (d.name === name && d.version === from) {
      return content.slice(0, d.vStart) + to + content.slice(d.vEnd);
    }
  }
  throw new Error(`could not locate <dependency> ${name} ${from} in pom.xml`);
}
