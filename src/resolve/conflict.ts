export interface NameVersion {
  name: string;
  version: string;
}

export interface EresolveConflict {
  /** The package npm already settled on (e.g. react@19.0.0). */
  found: NameVersion | null;
  /** The unsatisfied peer requirement (e.g. peer react@"^18.0.0"). */
  peer: { name: string; range: string } | null;
  /** The package imposing that peer requirement (the co-bump target). */
  from: NameVersion | null;
}

/** Split "name@version" handling scoped packages (@scope/name@version). */
export function splitNameVersion(s: string): NameVersion {
  const at = s.lastIndexOf("@");
  if (at <= 0) return { name: s, version: "" };
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

/**
 * Parse npm's ERESOLVE error text into a structured conflict.
 * Matches npm 11 output, e.g.:
 *
 *   Found: react@19.0.0
 *   peer react@"^18.0.0" from @testing-library/react@13.4.0
 */
export function parseEresolve(text: string): EresolveConflict {
  const found = (() => {
    const m = /Found:\s*(\S+)/.exec(text);
    return m ? splitNameVersion(m[1]!) : null;
  })();

  const peerMatch = /peer\s+(\S+?)@"([^"]+)"\s+from\s+(\S+)/.exec(text);
  const peer = peerMatch
    ? { name: peerMatch[1]!, range: peerMatch[2]! }
    : null;
  const from = peerMatch ? splitNameVersion(peerMatch[3]!) : null;

  return { found, peer, from };
}

/** A human-readable one-line summary of the conflict. */
export function describeConflict(c: EresolveConflict): string {
  if (c.peer && c.from && c.found) {
    return (
      `${c.from.name}@${c.from.version} requires peer ` +
      `${c.peer.name}@"${c.peer.range}", but the update wants ` +
      `${c.found.name}@${c.found.version}`
    );
  }
  return "unresolved dependency conflict (see raw npm output)";
}
