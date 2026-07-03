import { describe, it, expect } from "vitest";
import { isRoutineAllowed } from "../src/core/schedule.js";
import { ConfigSchema } from "../src/config/schema.js";

const sched = (s: unknown) => ConfigSchema.parse({ schedule: s }).schedule;

// Fixed UTC instants: 2026-07-06 is a Monday.
const mon09 = new Date("2026-07-06T09:00:00Z"); // Monday 09:00
const tue09 = new Date("2026-07-07T09:00:00Z"); // Tuesday 09:00
const mon23 = new Date("2026-07-06T23:00:00Z"); // Monday 23:00
const mon03 = new Date("2026-07-06T03:00:00Z"); // Monday 03:00

describe("isRoutineAllowed", () => {
  it("allows any time when the window is empty (default)", () => {
    expect(isRoutineAllowed(tue09, sched({}))).toBe(true);
  });

  it("gates by weekday (UTC)", () => {
    expect(isRoutineAllowed(mon09, sched({ days: ["mon"] }))).toBe(true);
    expect(isRoutineAllowed(tue09, sched({ days: ["mon"] }))).toBe(false);
    expect(isRoutineAllowed(tue09, sched({ days: ["mon", "tue"] }))).toBe(true);
  });

  it("gates by an [start, end) hour range", () => {
    expect(isRoutineAllowed(mon09, sched({ hours: [6, 10] }))).toBe(true);
    expect(isRoutineAllowed(mon09, sched({ hours: [10, 12] }))).toBe(false);
    expect(isRoutineAllowed(mon09, sched({ hours: [9, 10] }))).toBe(true); // start inclusive
    expect(isRoutineAllowed(mon09, sched({ hours: [6, 9] }))).toBe(false); // end exclusive
  });

  it("wraps a window past midnight when start > end", () => {
    const overnight = sched({ hours: [22, 6] });
    expect(isRoutineAllowed(mon23, overnight)).toBe(true); // 23:00
    expect(isRoutineAllowed(mon03, overnight)).toBe(true); // 03:00
    expect(isRoutineAllowed(mon09, overnight)).toBe(false); // 09:00
  });

  it("requires both day and hour when both are set", () => {
    const w = sched({ days: ["mon"], hours: [6, 10] });
    expect(isRoutineAllowed(mon09, w)).toBe(true);
    expect(isRoutineAllowed(mon23, w)).toBe(false); // right day, wrong hour
    expect(isRoutineAllowed(tue09, w)).toBe(false); // right hour, wrong day
  });
});
