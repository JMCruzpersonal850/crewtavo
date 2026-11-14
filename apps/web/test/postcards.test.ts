/**
 * A postcard campaign's page (features/marketing/PostcardPage.tsx), the parts it works out before
 * drawing (features/marketing/postcardForm.ts): the preview's address block is Lob's own.
 */
import { describe, expect, it } from "vitest";
import { blockStyle } from "../src/features/marketing/postcardForm";

describe("the preview of a postcard's back", () => {
  // Lob's templates, on the cut card: the block's size, 0.15 in from the right and 0.125 in from the bottom.
  const LOB = { "4x6": { card: [6, 4], block: [3.2835, 2.375] }, "6x9": { card: [9, 6], block: [4, 2.375] }, "6x11": { card: [11, 6], block: [4, 2.375] } } as const;

  it("draws Lob's address block where Lob prints it, at each size", () => {
    for (const size of ["4x6", "6x9", "6x11"] as const) {
      const style = blockStyle(size);
      const [left, top, width, height] = [style.left, style.top, style.width, style.height].map((v) => Number(v.replace("in", "")));
      expect(style.left.endsWith("in")).toBe(true);
      expect([width, height]).toEqual([...LOB[size].block]);
      expect(LOB[size].card[0] - (left! + width!)).toBeCloseTo(0.15, 4);
      expect(LOB[size].card[1] - (top! + height!)).toBeCloseTo(0.125, 4);
    }
  });
});
