import { describe, expect, it } from "vitest";
import { CLOCK_MODE_HINTS, CLOCK_MODE_LABELS, clockMode } from "../src/clock";

describe("how the clock works (settings.clock.mode)", () => {
  it("is visits only for a company with nothing saved, as every company was before the setting", () => {
    expect(clockMode({})).toBe("visits");
    expect(clockMode(null)).toBe("visits");
    expect(clockMode(undefined)).toBe("visits");
    expect(clockMode({ clock: { breaks: "paid", record_location: true } })).toBe("visits");
  });

  it("is the whole day only when the company says so", () => {
    expect(clockMode({ clock: { mode: "day" } })).toBe("day");
    expect(clockMode({ clock: { mode: "visits" } })).toBe("visits");
    expect(clockMode({ clock: { mode: "all day" } })).toBe("visits");
    expect(clockMode({ clock: "day" })).toBe("visits");
    expect(clockMode({ clock: null })).toBe("visits");
  });

  it("names both choices and says what each does in one line", () => {
    expect(CLOCK_MODE_LABELS).toEqual({ visits: "Visits only", day: "Whole day" });
    expect(CLOCK_MODE_HINTS.day).toContain("Travel between visits is on the clock");
    expect(CLOCK_MODE_HINTS.day).toContain("Stop for the day");
    expect(CLOCK_MODE_HINTS.visits).toContain("while a visit is in progress");
  });
});
