import type { Config } from "../config/schema.js";

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Whether routine updates are allowed to open PRs at `now`, per the configured
 * schedule window (evaluated in UTC, stateless). An empty window (no days, no
 * hours) means any time. `hours` is a half-open [start, end) range that wraps
 * past midnight when start > end (e.g. [22, 6] = 22:00–06:00). Security fixes
 * are never gated by this.
 */
export function isRoutineAllowed(now: Date, schedule: Config["schedule"]): boolean {
  const { days, hours } = schedule;

  if (days.length > 0) {
    const today = now.getUTCDay();
    if (!days.some((d) => DAY_INDEX[d] === today)) return false;
  }

  if (hours) {
    const [start, end] = hours;
    const h = now.getUTCHours();
    const inWindow = start <= end ? h >= start && h < end : h >= start || h < end;
    if (!inWindow) return false;
  }

  return true;
}
