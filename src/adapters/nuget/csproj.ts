import type { DependencyEntry } from "../types.js";

interface Ref {
  name: string;
  version: string;
  /** Offset span of the version *value* text within the content. */
  valueStart: number;
  valueEnd: number;
}

function attrValue(tag: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1]! : null;
}

/**
 * Locate every `<PackageReference>` / `<PackageVersion>` (Central Package
 * Management) and its version — whether written as a `Version="…"` attribute
 * (either attribute order) or a nested `<Version>…</Version>` element — returning
 * the version value's offset span so the same scan drives both parse and edit.
 */
function findRefs(content: string): Ref[] {
  const refs: Ref[] = [];
  const start = /<Package(?:Reference|Version)\b/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(content))) {
    const tagStart = m.index;
    const gt = content.indexOf(">", start.lastIndex);
    if (gt === -1) break;
    const selfClosing = content[gt - 1] === "/";
    const tag = content.slice(tagStart, gt + 1);
    const name = attrValue(tag, "Include") ?? attrValue(tag, "Update");
    start.lastIndex = gt + 1;
    if (!name) continue;

    const va = /\bVersion\s*=\s*"([^"]*)"/.exec(tag);
    if (va) {
      const valRel = va.index + va[0].indexOf('"', va[0].indexOf("=")) + 1;
      const valueStart = tagStart + valRel;
      refs.push({ name, version: va[1]!, valueStart, valueEnd: valueStart + va[1]!.length });
      continue;
    }
    if (!selfClosing) {
      const close = content.indexOf("</PackageReference>", gt);
      const region = content.slice(gt, close === -1 ? content.length : close);
      const cv = /<Version>\s*([^<]+?)\s*<\/Version>/.exec(region);
      if (cv) {
        const valueStart = gt + cv.index + cv[0].indexOf(cv[1]!);
        refs.push({ name, version: cv[1]!, valueStart, valueEnd: valueStart + cv[1]!.length });
      }
    }
  }
  return refs;
}

/** Parse NuGet package references from a `.csproj` / `Directory.Packages.props`. */
export function parseCsproj(content: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  for (const r of findRefs(content)) {
    const key = `${r.name}@${r.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.name, range: r.version, kind: "prod" });
  }
  return out;
}

/** Replace the version of package `name` (currently `from`) with `to`. */
export function editPackageReference(
  content: string,
  name: string,
  from: string,
  to: string,
): string {
  for (const r of findRefs(content)) {
    if (r.name === name && r.version === from) {
      return content.slice(0, r.valueStart) + to + content.slice(r.valueEnd);
    }
  }
  throw new Error(`could not locate <PackageReference> ${name} ${from} in project file`);
}
