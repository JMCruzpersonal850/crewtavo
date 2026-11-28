/**
 * The booking page's choice lines (features/booking/BookingIndexPage.tsx): what picking a form
 * does, said the way the form itself will behave — a time picked on a form that books at once is
 * a booking; on one that waits for the office it's a time asked for, confirmed after.
 */
import { describe, expect, it } from "vitest";
import { formBlurb } from "../src/features/booking/BookingIndexPage";

describe("a form's line on the booking page", () => {
  it("a time picked is a booking when the form books at once, and a time asked for when it waits on the office", () => {
    expect(formBlurb({ kind: "assessment", pick_time: true, requires_approval: false })).toBe("Pick a time and you're booked");
    expect(formBlurb({ kind: "booking", pick_time: true, requires_approval: true })).toBe("Pick a time — we'll confirm it with you");
  });

  it("without times, the kind says what it is", () => {
    expect(formBlurb({ kind: "booking", pick_time: false, requires_approval: false })).toBe("Book a service");
    expect(formBlurb({ kind: "assessment", pick_time: false, requires_approval: false })).toBe("Ask us to come out and take a look");
    expect(formBlurb({ kind: "request", pick_time: false, requires_approval: false })).toBe("Send us a request");
  });
});
