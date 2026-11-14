/**
 * How you compare (features/marketing/ReviewCompare.tsx): Google's ratings are shown with what its
 * Places API policies ask for (developers.google.com/maps/documentation/places/web-service/policies):
 * the "Google Maps" attribution, unstyled beyond what it allows, and its notice about reviews with
 * the link to its policy. And the change column says what it's counted from.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { GOOGLE_ATTRIBUTION, GOOGLE_REVIEW_NOTICE, GOOGLE_REVIEW_POLICY_LABEL, GOOGLE_REVIEW_POLICY_URL } from "@crewtavo/core/reviewCompare";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
const card = source("features/marketing/ReviewCompare.tsx");
const css = source("styles/features.css");

describe("Google's ratings, shown as Google asks", () => {
  it("carry the attribution and the review notice in Google's own words", () => {
    // Written out from the policy page, not from the code.
    expect(GOOGLE_ATTRIBUTION).toBe("Google Maps");
    expect(GOOGLE_REVIEW_NOTICE).toBe("Reviews aren't verified by Google, but Google checks for and removes fake content when it's identified.");
    expect(GOOGLE_REVIEW_POLICY_LABEL).toBe("Learn more about Google Maps user-generated content policy");
    expect(GOOGLE_REVIEW_POLICY_URL).toBe("https://support.google.com/contributionpolicy/answer/7422880");
  });

  it("show them wherever a rating is shown: on the card and in the search for a business to add", () => {
    const notice = card.slice(card.indexOf("function GoogleNotice"), card.indexOf("function AddPlaceDialog"));
    expect(notice).toContain('<span className="google-attribution" translate="no">{GOOGLE_ATTRIBUTION}</span>');
    expect(notice).toContain("{GOOGLE_REVIEW_NOTICE}");
    expect(notice).toContain("href={GOOGLE_REVIEW_POLICY_URL}");
    const main = card.slice(card.indexOf("export function ReviewCompare"), card.indexOf("function GoogleNotice"));
    const dialog = card.slice(card.indexOf("function AddPlaceDialog"));
    expect(main).toContain("<GoogleNotice />");
    expect(dialog).toContain("<GoogleNotice />");
    // Inside the card and the dialog, which are the ratings' own boxes.
    expect(main.indexOf("<GoogleNotice />")).toBeLessThan(main.lastIndexOf("</section>"));
  });

  it("keep the attribution to the type Google allows: a sans-serif at weight 400, 12 to 16px, its grey or white, never wrapped", () => {
    const rule = /\.google-attribution \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/font-family: Roboto, [^;]*sans-serif;/);
    expect(rule).toContain("font-weight: 400;");
    expect(rule).toContain("letter-spacing: normal;");
    expect(rule).toContain("white-space: nowrap;");
    const size = Number(/font-size: (\d+)px;/.exec(rule)?.[1]);
    expect(size).toBeGreaterThanOrEqual(12);
    expect(size).toBeLessThanOrEqual(16);
    expect(rule.toLowerCase()).toContain("color: #5e5e5e;");
    expect(css).toMatch(/:root\.dark \.google-attribution \{ color: #fff; \}/);
  });
});

describe("the change in each place's reviews", () => {
  it("is headed by the day it's counted from, not by 'since last check'", () => {
    expect(card).toContain("{since ? `Since ${formatDate(since)}` : \"Change\"}");
    expect(card).not.toContain("Since last check");
  });
});
