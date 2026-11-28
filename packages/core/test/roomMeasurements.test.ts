import { describe, expect, it } from "vitest";
import { ceilingSqFt, roomAreas, wallSqFt } from "../src/roomMeasurements";

describe("room measurements", () => {
  it("works out wall area as the perimeter times the height", () => {
    expect(wallSqFt(12, 10, 8)).toBe(352);
    expect(wallSqFt(10.5, 9.25, 8)).toBe(316);
  });

  it("works out ceiling area as length times width", () => {
    expect(ceilingSqFt(12, 10)).toBe(120);
    expect(ceilingSqFt(10.5, 9.25)).toBe(97.13);
  });

  it("rounds areas to two decimals", () => {
    expect(wallSqFt(10.33, 9.11, 8.5)).toBe(330.48);
    expect(ceilingSqFt(10.33, 9.11)).toBe(94.11);
  });

  it("gives zero, not a guess, for missing or non-positive dimensions", () => {
    expect(wallSqFt(0, 10, 8)).toBe(0);
    expect(wallSqFt(12, -1, 8)).toBe(0);
    expect(wallSqFt(12, 10, 0)).toBe(0);
    expect(ceilingSqFt(0, 10)).toBe(0);
    expect(ceilingSqFt(12, Number.NaN)).toBe(0);
  });

  it("gives a room's walls and ceiling together", () => {
    expect(roomAreas({ length_ft: 12, width_ft: 10, height_ft: 8 })).toEqual({ walls: 352, ceiling: 120 });
  });

  it("leaves walls unknown when no height was taken, but still knows the ceiling", () => {
    expect(roomAreas({ length_ft: 12, width_ft: 10, height_ft: null })).toEqual({ walls: null, ceiling: 120 });
  });

  it("leaves walls unknown when the height wasn't a real measurement", () => {
    expect(roomAreas({ length_ft: 12, width_ft: 10, height_ft: 0 })).toEqual({ walls: null, ceiling: 120 });
  });

  it("gives nothing for a room that wasn't measured", () => {
    expect(roomAreas({ length_ft: null, width_ft: null, height_ft: 8 })).toEqual({ walls: 0, ceiling: 0 });
    expect(roomAreas({ length_ft: null, width_ft: 10, height_ft: null })).toEqual({ walls: null, ceiling: 0 });
  });
});
