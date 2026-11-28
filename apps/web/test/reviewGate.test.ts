/**
 * The review gate page (/r/:token, features/public/ReviewGatePage.tsx): the client rates first.
 * 4-5 stars are sent on to the business's public review page (the gate facts' review_url);
 * 1-3 stars never leave for a public page — they open a private note the page posts to the
 * gate's feedback route, which lands in review_feedback for the office. Source patterns, the
 * way this suite checks the other public pages; the routes themselves are covered in the API's
 * reviewGate.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../src/features/public/ReviewGatePage.tsx", import.meta.url), "utf8");

describe("the review gate page", () => {
  it("reads its facts from the gate route, review page included", () => {
    expect(page).toContain("publicFetch<Gate>(`/public/r/${token}/gate`)");
    expect(page).toContain("review_url: string");
  });

  it("offers five stars, each with its word", () => {
    expect(page).toContain("[1, 2, 3, 4, 5].map((n)");
    expect(page).toContain('const STAR_WORDS = ["", "Poor", "Fair", "Okay", "Good", "Excellent"];');
  });

  it("sends 4-5 stars on to the business's review page, and nothing else there", () => {
    expect(page).toContain("{stars >= 4 && (");
    expect(page).toContain('<a className={k.cta} href={data.review_url}>Leave a review</a>');
  });

  it("keeps 1-3 stars private: a note posted to the feedback route, never a public link", () => {
    expect(page).toContain("{stars >= 1 && stars <= 3 && (");
    expect(page).toContain("publicFetch<{ ok: true }>(`/public/r/${token}/feedback`, { stars, comment: comment.trim() })");
    // The review page's link exists exactly once on the page: in the 4-5 star branch.
    expect(page.match(/data\.review_url/g)).toHaveLength(1);
  });
});
