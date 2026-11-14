/**
 * What a drafted quote tells the office (quotes/DraftedCallout.tsx): who drafted it, the lines whose
 * quantity to check (only those still on it), and why Claude didn't draft it when it was meant to.
 */
import { describe, expect, it } from "vitest";
import { draftedWords, readDrafted, readyDraft } from "@/features/quotes/DraftedCallout";

describe("a drafted quote", () => {
  it("reads quotes.drafted, and anything else as not drafted", () => {
    expect(readDrafted(null)).toBeNull();
    expect(readDrafted({ by: "someone" })).toBeNull();
    expect(readDrafted({ by: "claude", request_number: 12, check: ["l1", 3], notes: "Size: Large" })).toEqual({ by: "claude", request_number: 12, check: ["l1"], lines: null, notes: "Size: Large", note: null });
  });

  it("points a request at the draft made by itself as it came in, until that quote is sent", () => {
    const auto = { id: "q1", number: 40, status: "draft", drafted: { by: "claude", auto: true } };
    expect(readyDraft([{ id: "q0", number: 39, status: "draft", drafted: null }, auto])).toEqual({ quote: auto, by: "claude" });
    expect(readyDraft([{ ...auto, drafted: { by: "price_list", auto: true } }])?.by).toBe("price_list");
    // Sent, it's a quote like any other; one a person drafted marked the request Quoted already.
    expect(readyDraft([{ ...auto, status: "sent" }])).toBeNull();
    expect(readyDraft([{ id: "q2", number: 41, status: "draft", drafted: { by: "claude" } }])).toBeNull();
    expect(readyDraft([])).toBeNull();
    expect(readDrafted({ by: "claude", auto: true })?.auto).toBe(true);
    expect(readDrafted({ by: "claude", auto: "yes" })).not.toHaveProperty("auto");
  });

  it("says who drafted it and what to check", () => {
    expect(draftedWords({ by: "claude", request_number: 12 }, ["Mowing", "Edging"])).toEqual([
      "Claude drafted this from request #12 and your price list. Look it over before you send it.",
      "Check the quantity on Mowing, Edging: the request didn't say, so it's 1.",
    ]);
    expect(draftedWords({ by: "price_list", note: "Claude couldn't draft this one (busy), so it was drafted from your price list." }, [])).toEqual([
      "Drafted from the request and your price list. Look it over before you send it.",
      "Claude couldn't draft this one (busy), so it was drafted from your price list.",
    ]);
    // A draft that came with no lines isn't called drafted.
    expect(draftedWords({ by: "price_list", request_number: 7, lines: 0, note: "Nothing on your price list matched what they asked for. Add the lines yourself." }, [])).toEqual([
      "Started from request #7.",
      "Nothing on your price list matched what they asked for. Add the lines yourself.",
    ]);
  });
});
