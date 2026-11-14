/**
 * What a postcard campaign's page (PostcardPage.tsx) works out before it draws anything, kept apart
 * from the page so it can be tested: where the preview draws Lob's address block.
 */
import { addressBlock, BLEED_IN, type PostcardSize } from "@crewtavo/core/postcards";

/**
 * Where the preview draws Lob's address block on the back: Lob's own block for the size
 * (addressBlock, on the artwork with its bleed), placed on the cut card the preview shows.
 */
export function blockStyle(size: PostcardSize): { left: string; top: string; width: string; height: string } {
  const block = addressBlock(size);
  const inches = (value: number) => `${Math.round(value * 10_000) / 10_000}in`;
  return { left: inches(block.left - BLEED_IN), top: inches(block.top - BLEED_IN), width: inches(block.width), height: inches(block.height) };
}
