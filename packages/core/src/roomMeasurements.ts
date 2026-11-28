/**
 * Room measurements: the areas a proposal prices from, worked out from the dimensions an
 * estimator typed in on a site visit (visit_measurements: a room's length, width and, when
 * they took it, its ceiling height — all in feet).
 *
 * These are manual tape-measure dimensions, entered by a person standing in the room. A web
 * app cannot reach iPhone LiDAR: Safari has no WebXR, so there is no way for this code to
 * scan a room or measure anything by itself, and nothing here pretends to — the numbers are
 * only ever as good as the tape measure and the typing. If automatic measuring ever arrives
 * it will come from a native app handing dimensions in, and they will land in these same
 * functions.
 */

/** Round an area to two decimals, the way areas are shown and priced. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A dimension that counts: a finite, positive number of feet. Anything else is no measurement. */
const usable = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The wall area of a rectangular room, in square feet: the perimeter times the ceiling
 * height, 2 × (length + width) × height. Zero when any of the three dimensions is missing
 * or not positive — a room with no height has no wall area to price, not a guessed one.
 */
export function wallSqFt(lengthFt: number, widthFt: number, heightFt: number): number {
  if (!usable(lengthFt) || !usable(widthFt) || !usable(heightFt)) return 0;
  return round2(2 * (lengthFt + widthFt) * heightFt);
}

/**
 * The ceiling (or floor) area of a rectangular room, in square feet: length × width.
 * Zero when either dimension is missing or not positive.
 */
export function ceilingSqFt(lengthFt: number, widthFt: number): number {
  if (!usable(lengthFt) || !usable(widthFt)) return 0;
  return round2(lengthFt * widthFt);
}

/** A visit_measurements row's dimensions, as the database spells them. */
export interface RoomDimensions {
  length_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
}

/**
 * A measured room's areas: its ceiling (length × width, always computable from a measured
 * length and width) and its walls — null when no height was taken, because wall area can't
 * be known without one and a made-up number would price real work. A room whose length or
 * width wasn't measured has a ceiling of 0 and no walls.
 */
export function roomAreas(m: RoomDimensions): { walls: number | null; ceiling: number } {
  return {
    walls: usable(m.height_ft) ? wallSqFt(m.length_ft ?? 0, m.width_ft ?? 0, m.height_ft) : null,
    ceiling: ceilingSqFt(m.length_ft ?? 0, m.width_ft ?? 0),
  };
}
