/**
 * What a postcard campaign's page (PostcardPage.tsx) works out before it draws anything, kept apart
 * from the page so it can be tested: where the preview draws Lob's address block.
 */
import { addressBlock, BLEED_IN, LOB_PROOF_DAYS, POSTCARD_KEEP_DAYS, type PostcardSize } from "@crewtavo/core/postcards";

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

const DAY = 86_400_000;

/** Lob's link to its picture of a card, while it still works (30 days from when Lob gave it), else null. */
export function proofLink(r: { proof_url?: string | null; proof_at?: string | null }, now = Date.now()): string | null {
  if (!r.proof_url || !r.proof_at || !r.proof_url.startsWith("https://")) return null;
  return now - Date.parse(r.proof_at) < LOB_PROOF_DAYS * DAY ? r.proof_url : null;
}

/**
 * The day a sent or stopped campaign can be deleted, or null when it can be now. Lob fetches the
 * front's picture from this server while it draws the cards, and deleting the campaign takes the
 * picture down, so it stays for POSTCARD_KEEP_DAYS days after the last card (the database refuses
 * a delete before then too). A campaign none of whose cards reached Lob has nothing to keep.
 */
export function deletableFrom(c: { status: string; started_at: string | null; finished_at: string | null; made_count: number; failed_count: number }, now = Date.now()): Date | null {
  if (c.status === "draft" || c.made_count + c.failed_count === 0) return null;
  const last = Date.parse(c.finished_at ?? c.started_at ?? "");
  if (!Number.isFinite(last)) return null;
  const from = last + POSTCARD_KEEP_DAYS * DAY;
  return from > now ? new Date(from) : null;
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
