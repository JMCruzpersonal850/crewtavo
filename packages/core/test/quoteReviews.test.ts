/**
 * The Google reviews a quote shows (src/reviews.ts quoteReviews): the office's picks in order, else
 * the newest with 5 stars and words; never one taken off Google; three at most; the reviewer by
 * first name and initial; the words trimmed.
 */
import { describe, expect, it } from "vitest";
import { quoteReviews, reviewerShortName, trimReview, type QuoteReviewRow } from "../src/reviews";

const review = (over: Partial<QuoteReviewRow>): QuoteReviewRow => ({
  reviewer_name: "Dana Whitfield", reviewer_anonymous: false, rating: 5, comment: "Great job.", posted_at: "2026-10-01T15:00:00Z", quote_pick: null, deleted_at: null, ...over,
});

describe("reviews on quotes", () => {
  it("shows the newest three with 5 stars and words when none are picked", () => {
    const rows = [
      review({ reviewer_name: "Ann Old", posted_at: "2026-01-01T00:00:00Z" }),
      review({ reviewer_name: "Bo Four", rating: 4, posted_at: "2026-11-01T00:00:00Z" }),
      review({ reviewer_name: "Cy Quiet", comment: "  ", posted_at: "2026-11-02T00:00:00Z" }),
      review({ reviewer_name: "Di New", posted_at: "2026-11-03T00:00:00Z" }),
      review({ reviewer_name: "Ed Gone", posted_at: "2026-11-04T00:00:00Z", deleted_at: "2026-11-05T00:00:00Z" }),
      review({ reviewer_name: "Fay Mid", posted_at: "2026-06-01T00:00:00Z" }),
      review({ reviewer_name: "Gus Older", posted_at: "2025-06-01T00:00:00Z" }),
    ];
    expect(quoteReviews(rows).map((r) => r.name)).toEqual(["Di N.", "Fay M.", "Ann O."]);
  });

  it("shows the office's picks in their order, whatever their stars", () => {
    const rows = [
      review({ reviewer_name: "Ann Five", posted_at: "2026-11-03T00:00:00Z" }),
      review({ reviewer_name: "Bo Picked", rating: 4, comment: "Good, a bit late.", quote_pick: 2 }),
      review({ reviewer_name: "Cy First", quote_pick: 1 }),
    ];
    expect(quoteReviews(rows)).toEqual([
      { name: "Cy F.", rating: 5, date: "2026-10-01", text: "Great job." },
      { name: "Bo P.", rating: 4, date: "2026-10-01", text: "Good, a bit late." },
    ]);
  });

  it("falls back to the newest when every pick was taken off Google, and shows nothing with nothing to show", () => {
    expect(quoteReviews([review({ quote_pick: 1, deleted_at: "2026-11-01T00:00:00Z" }), review({ reviewer_name: "Al Live" })]).map((r) => r.name)).toEqual(["Al L."]);
    expect(quoteReviews([review({ rating: 3 }), review({ comment: null })])).toEqual([]);
    expect(quoteReviews([])).toEqual([]);
  });

  it("names a reviewer by first name and last initial, never in full", () => {
    expect(reviewerShortName({ reviewer_name: "Dana Whitfield-Jones", reviewer_anonymous: false })).toBe("Dana W.");
    expect(reviewerShortName({ reviewer_name: "  maria  de la  cruz ", reviewer_anonymous: false })).toBe("maria C.");
    expect(reviewerShortName({ reviewer_name: "Prince", reviewer_anonymous: false })).toBe("Prince");
    expect(reviewerShortName({ reviewer_name: "José Ñúñez", reviewer_anonymous: false })).toBe("José Ñ.");
    expect(reviewerShortName({ reviewer_name: "Dana Whitfield", reviewer_anonymous: true })).toBe("A Google user");
    expect(reviewerShortName({ reviewer_name: null, reviewer_anonymous: false })).toBe("A Google user");
  });

  it("trims long words at a word, and folds line breaks", () => {
    expect(trimReview("Fast,\n\nfriendly   and fair.")).toBe("Fast, friendly and fair.");
    const long = `${"Really great work on the deck. ".repeat(12)}`;
    const cut = trimReview(long, 60);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut).toBe("Really great work on the deck. Really great work on the…");
    expect(trimReview(null)).toBe("");
  });
});
