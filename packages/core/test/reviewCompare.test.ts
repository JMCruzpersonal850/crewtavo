import { describe, expect, it } from "vitest";
import { autoDue, changesSince, changeWords, countChange, nextHandCheck, ranked, standing, standingWords, type ComparedPlace } from "../src/reviewCompare";

const place = (id: string, rating: number | null, total: number | null, previous: number | null = null, own = false): ComparedPlace => ({
  id, name: id, is_own: own, rating, ratings_total: total, previous_total: previous, checked_at: "2026-11-13T10:00:00Z", previous_checked_at: previous == null ? null : "2026-11-06T10:00:00Z",
});

describe("how the counts changed", () => {
  it("is the reviews gained since the check before, or nothing to say without one", () => {
    expect(countChange(place("a", 4.5, 120, 117))).toBe(3);
    expect(countChange(place("a", 4.5, 115, 117))).toBe(-2);
    expect(countChange(place("a", 4.5, 120))).toBeNull();
    expect(changeWords(3)).toBe("+3");
    expect(changeWords(-2)).toBe("−2");
    expect(changeWords(0)).toBe("No change");
    expect(changeWords(1234)).toBe("+1,234");
    expect(changeWords(null)).toBe("");
  });

  it("says the day the changes are counted from, the earliest among the places that have one", () => {
    expect(changesSince([place("a", 4.5, 120, 117), place("b", 4.1, 50, 50)])).toBe("2026-11-06T10:00:00Z");
    expect(changesSince([{ ...place("a", 4.5, 120, 117), previous_checked_at: "2026-11-01T10:00:00Z" }, place("b", 4.1, 50, 50)])).toBe("2026-11-01T10:00:00Z");
    // A place just added has nothing from before, and doesn't decide it.
    expect(changesSince([place("new", 4.5, 120)])).toBeNull();
    expect(changesSince([])).toBeNull();
  });
});

describe("where the business stands", () => {
  const places = [place("us", 4.6, 80, 74, true), place("big", 4.8, 300, 290), place("mid", 4.6, 120, 120), place("low", 3.9, 40, 38), place("new", null, null)];

  it("ranks by rating, then by number of reviews, with places not checked yet last", () => {
    expect(ranked(places).map((p) => p.id)).toEqual(["big", "mid", "us", "low", "new"]);
  });

  it("compares the business with the competitors' averages", () => {
    // Competitors with a rating: 4.8, 4.6, 3.9 → 4.43; reviews 300, 120, 40 → 153.3; gained 10, 0, 2 → 4.
    expect(standing(places)).toEqual({ rank: 3, of: 4, ratingVsAverage: 0.2, reviewsVsAverage: -73, gained: 6, averageGained: 4 });
    expect(standingWords({ rank: 3, of: 4 })).toBe("3rd of 4 by rating");
    expect(standingWords({ rank: 1, of: 6 })).toBe("Highest rated of 6");
    expect(standingWords({ rank: 2, of: 6 })).toBe("2nd of 6 by rating");
    expect(standingWords({ rank: 11, of: 12 })).toBe("11th of 12 by rating");
  });

  it("says nothing without the business's own place or a competitor checked", () => {
    expect(standing(places.filter((p) => !p.is_own))).toBeNull();
    expect(standing([place("us", 4.6, 80, null, true), place("new", null, null)])).toBeNull();
    expect(standing([place("us", 4.6, 80, null, true), place("b", 4.0, 10)])).toMatchObject({ rank: 1, of: 2, gained: null, averageGained: null });
  });
});

describe("when Google is asked", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  it("checks weekly by itself", () => {
    expect(autoDue(null, now)).toBe(true);
    expect(autoDue("2026-11-08T12:00:00Z", now)).toBe(false);
    expect(autoDue("2026-11-07T12:00:00Z", now)).toBe(true);
  });

  it("checks by hand at most once a day, counting the weekly check", () => {
    expect(nextHandCheck(null, now)).toBeNull();
    expect(nextHandCheck("2026-11-14T08:00:00Z", now)?.toISOString()).toBe("2026-11-15T08:00:00.000Z");
    expect(nextHandCheck("2026-11-13T11:00:00Z", now)).toBeNull();
  });
});
