import type { Versioning } from "./types.js";
import { semverVersioning, makeSemverVersioning } from "./semver.js";
import { pep440Versioning } from "./pep440.js";
import { gemVersioning } from "./gem.js";

// Go module tags are semver with a leading `v` (and +incompatible suffixes).
const goVersioning = makeSemverVersioning("go", true);

const REGISTRY: Record<string, Versioning> = {
  semver: semverVersioning,
  npm: semverVersioning,
  pep440: pep440Versioning,
  go: goVersioning,
  gem: gemVersioning,
};

export function getVersioning(id: string): Versioning {
  const v = REGISTRY[id];
  if (!v) throw new Error(`unknown versioning scheme: ${id}`);
  return v;
}

export type { Versioning, VersionDiff } from "./types.js";
