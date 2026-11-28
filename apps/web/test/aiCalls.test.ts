/**
 * AI Calls' shaping (features/voice/aiCalls.ts): the outcome filter chips and what each one
 * matches, the tone an outcome wears, and how a call's extracted details read on its detail view.
 */
import { describe, expect, it } from "vitest";
import { durationLabel, extractedRows, matchesOutcomeFilter, OUTCOME_FILTERS, outcomeTone } from "../src/features/voice/aiCalls";

describe("the outcome filter chips", () => {
  it("are All, Booked, Messages, Questions, Transferred and Other, in that order", () => {
    expect(OUTCOME_FILTERS.map((f) => f.label)).toEqual(["All", "Booked", "Messages", "Questions", "Transferred", "Other"]);
  });

  it("send no outcome for All, and the API's exact outcome value for every other chip", () => {
    expect(OUTCOME_FILTERS.find((f) => f.key === "all")?.param).toBeNull();
    // The list endpoint matches ?outcome= exactly, against booked/message/faq/transferred/other.
    expect(OUTCOME_FILTERS.map((f) => f.param)).toEqual([null, "booked", "message", "faq", "transferred", "other"]);
  });

  it("match the raw outcomes each chip means", () => {
    expect(matchesOutcomeFilter("booked", "booked")).toBe(true);
    expect(matchesOutcomeFilter("booked", "messages")).toBe(false);
    expect(matchesOutcomeFilter("message", "messages")).toBe(true);
    expect(matchesOutcomeFilter("faq", "questions")).toBe(true);
    expect(matchesOutcomeFilter("transferred", "transferred")).toBe(true);
    expect(matchesOutcomeFilter("other", "other")).toBe(true);
    expect(matchesOutcomeFilter("Booked", "booked")).toBe(true);
  });

  it("put anything unclaimed under Other, and everything under All", () => {
    expect(matchesOutcomeFilter("hung_up", "other")).toBe(true);
    expect(matchesOutcomeFilter(null, "other")).toBe(true);
    expect(matchesOutcomeFilter("booked", "other")).toBe(false);
    expect(matchesOutcomeFilter("anything", "all")).toBe(true);
    expect(matchesOutcomeFilter(null, "all")).toBe(true);
  });
});

describe("an outcome's tone", () => {
  it("is good for a booking, a warning for a transfer, and info for a message", () => {
    expect(outcomeTone("booked")).toBe("good");
    expect(outcomeTone("transferred")).toBe("warning");
    expect(outcomeTone("message")).toBe("info");
    expect(outcomeTone("faq")).toBe("muted");
    expect(outcomeTone("failed")).toBe("danger");
    expect(outcomeTone(null)).toBe("muted");
  });
});

describe("a call's length", () => {
  it("reads in seconds under a minute, then minutes and seconds", () => {
    expect(durationLabel(45)).toBe("45s");
    expect(durationLabel(60)).toBe("1m");
    expect(durationLabel(200)).toBe("3m 20s");
    expect(durationLabel(null)).toBeNull();
    expect(durationLabel(-5)).toBeNull();
  });
});

describe("the details the agent took down", () => {
  it("names the known ones first, in reading order, and keeps anything else after", () => {
    const rows = extractedRows({ message: "Gate code 1234", name: "Sam Hill", service: "Fence", preferred_time: "Tuesday morning", zip: "32526", phone: "850 555 0100" });
    expect(rows.map((r) => r.label)).toEqual(["Name", "Phone", "Service", "Preferred time", "Message", "zip"]);
    expect(rows[0]).toEqual({ label: "Name", value: "Sam Hill" });
  });

  it("leaves blank values and non-text values out, and has no rows for nothing", () => {
    expect(extractedRows({ name: "  ", service: null, nested: { a: 1 } })).toEqual([]);
    expect(extractedRows(null)).toEqual([]);
    expect(extractedRows(undefined)).toEqual([]);
  });
});
