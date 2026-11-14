/**
 * What a postcard campaign's page (PostcardPage.tsx) works out before it draws anything, kept apart
 * from the page so it can be tested: where the preview draws Lob's address block.
 */
import { addressBlock, BLEED_IN, type PostcardSize } from "@crewtavo/core/postcards";

/**
 * The photos offered for a card's front: those the database says may be shown (`shared`, from
 * public.social_photos: marked OK to share, never of a client who said not to post photos of their
 * property), in its order, and of those only the ones the person looking can open themselves
 * (`readable`, their own read of attachments, which also says whether a photo has a drawn-on copy).
 */
export function pickablePhotos<S extends { id: string }, R extends { id: string }>(shared: readonly S[], readable: readonly R[]): R[] {
  const mine = new Map(readable.map((photo) => [photo.id, photo]));
  return shared.map((photo) => mine.get(photo.id)).filter((photo): photo is R => photo !== undefined);
}

/**
 * Where the preview draws Lob's address block on the back: Lob's own block for the size
 * (addressBlock, on the artwork with its bleed), placed on the cut card the preview shows.
 */
export function blockStyle(size: PostcardSize): { left: string; top: string; width: string; height: string } {
  const block = addressBlock(size);
  const inches = (value: number) => `${Math.round(value * 10_000) / 10_000}in`;
  return { left: inches(block.left - BLEED_IN), top: inches(block.top - BLEED_IN), width: inches(block.width), height: inches(block.height) };
}
