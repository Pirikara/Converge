import type { EresolveConflict } from "./conflict.js";

export interface PackageChange {
  name: string;
  fromRange: string;
  toRange: string;
  /** True when this change was added automatically to satisfy a conflict. */
  cobump: boolean;
}

export interface ResolvedFile {
  /** Filename relative to the manifest dir (package.json, package-lock.json). */
  name: string;
  content: string;
}

export interface ResolveSuccess {
  status: "resolved" | "resolved-cobump";
  strategy: string;
  changes: PackageChange[];
  files: ResolvedFile[];
}

export interface ResolveFailure {
  status: "unsolvable";
  reason: string;
  conflict: EresolveConflict | null;
  /** Trimmed raw npm output for the report. */
  rawError: string;
  /** Strategies that were attempted before giving up. */
  attempted: string[];
}

export type ResolveOutcome = ResolveSuccess | ResolveFailure;

export interface ResolveRequest {
  /** Working copy containing package.json (+ lockfile) to mutate. */
  workdir: string;
  name: string;
  fromRange: string;
  toRange: string;
}
