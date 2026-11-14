/**
 * Postcards by mail: a one-off campaign printed and mailed through the business's own Lob account
 * (Apps → Lob; apps/api/src/integrations/lob.ts). Shared by the API, which builds what Lob prints,
 * and Marketing → Campaigns, which previews exactly that at its real size: the card's sizes, the
 * words on its back, the address it goes to, and why a client is left out. The database picks who
 * it goes to the same way (public.postcard_audience, 20261113001400_postcards.sql).
 */
import { renderTemplate, type TemplateVars } from "./automations";

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

export const POSTCARD_SIZES = ["4x6", "6x9", "6x11"] as const;
export type PostcardSize = (typeof POSTCARD_SIZES)[number];
export const isPostcardSize = (value: unknown): value is PostcardSize => typeof value === "string" && (POSTCARD_SIZES as readonly string[]).includes(value);

/** What's printed past the edge on every side, so a picture runs to the edge once the card is cut. */
export const BLEED_IN = 0.125;

/**
 * Each size as mailed, wide side across, in inches. Lob names them height by width ("4x6" is 6 in
 * across and 4 in high). `maxMessage` is guidance for the page ("about 600 characters fit"): what
 * ordinary sentences of that length come to on the back as backFit measures it, with room to
 * spare. Whether a client's card really fits is backFit's to say, not this number's.
 */
export const POSTCARD_SIZE_INFO: Record<PostcardSize, { width: number; height: number; label: string; maxMessage: number; fontPt: number }> = {
  "4x6": { width: 6, height: 4, label: "4 × 6 in", maxMessage: 600, fontPt: 10 },
  "6x9": { width: 9, height: 6, label: "6 × 9 in", maxMessage: 1300, fontPt: 12 },
  "6x11": { width: 11, height: 6, label: "6 × 11 in", maxMessage: 1500, fontPt: 12 },
};

/** A card's size with its bleed, as Lob takes the artwork. */
export const artboard = (size: PostcardSize) => ({ width: POSTCARD_SIZE_INFO[size].width + 2 * BLEED_IN, height: POSTCARD_SIZE_INFO[size].height + 2 * BLEED_IN });

/**
 * Lob's ink-free area on the back, where it prints the business's return address, the client's
 * address, the barcode and the postage itself: nothing of ours may be there. From Lob's templates
 * for each size (help.lob.com → Designing mail creatives → Mail piece design specs → Postcards, the
 * templates dated 4.3.26, read 2026-11-14): 3.2835 × 2.375 in on a 4x6 and 4 × 2.375 in on a 6x9 and
 * a 6x11, 0.275 in from the right edge and 0.25 in from the bottom of the artwork with its bleed
 * (0.15 in and 0.125 in from the cut card's). The one place to change if Lob's templates do.
 */
export const LOB_ADDRESS_BLOCK: Record<PostcardSize, { width: number; height: number; right: number; bottom: number }> = {
  "4x6": { width: 3.2835, height: 2.375, right: 0.275, bottom: 0.25 },
  "6x9": { width: 4, height: 2.375, right: 0.275, bottom: 0.25 },
  "6x11": { width: 4, height: 2.375, right: 0.275, bottom: 0.25 },
};

const inches = (value: number) => Math.round(value * 10_000) / 10_000;

/** Lob's address block on the artwork (with its bleed): its left and top edges and its size, in inches. */
export function addressBlock(size: PostcardSize): { left: number; top: number; width: number; height: number } {
  const art = artboard(size);
  const block = LOB_ADDRESS_BLOCK[size];
  return { left: inches(art.width - block.right - block.width), top: inches(art.height - block.bottom - block.height), width: block.width, height: block.height };
}

/** The message stays this far inside the cut edge, and this far from Lob's address block. */
const EDGE_IN = 0.25;
const BLOCK_GAP_IN = 0.125;
/** A line longer than this is hard to read: the widest the message runs on the big cards. */
const MAX_LINE_IN = 7;
const LINE_HEIGHT = 1.35;
/** The space after a paragraph, in ems. */
const PARAGRAPH_GAP_EM = 0.6;

/**
 * Where the message goes on the back, in inches on the artwork: a box inside the cut edge, with its
 * bottom right corner cut out for Lob's address block and a gap round it. The words run the box's
 * full width above the block (`aboveBlock` high) and `besideBlock` wide down its left side.
 */
export function backLayout(size: PostcardSize) {
  const art = artboard(size);
  const block = addressBlock(size);
  const inset = BLEED_IN + EDGE_IN;
  const width = inches(Math.min(art.width - 2 * inset, MAX_LINE_IN));
  const height = inches(art.height - 2 * inset);
  const cutWidth = inches(Math.max(0, inset + width - (block.left - BLOCK_GAP_IN)));
  const aboveBlock = inches(Math.max(0, block.top - BLOCK_GAP_IN - inset));
  const fontIn = POSTCARD_SIZE_INFO[size].fontPt / 72;
  return { left: inset, top: inset, width, height, cutWidth, aboveBlock, cutHeight: inches(height - aboveBlock), besideBlock: inches(width - cutWidth), fontIn, lineIn: fontIn * LINE_HEIGHT, paragraphGapIn: fontIn * PARAGRAPH_GAP_EM };
}

// ---------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------

/**
 * The merge fields a card's back can use: an email campaign's, except that {{link}} is printed, so
 * it's the business's booking form (or its website), which someone can type, not a Client Hub link.
 */
export const POSTCARD_TOKENS = [
  { token: "client.first_name", label: "First name" },
  { token: "client.name", label: "Full name" },
  { token: "company.name", label: "Your company" },
  { token: "company.phone", label: "Your phone" },
  { token: "link", label: "Booking link" },
] as const;

/** The words a client's card says. */
export function postcardMessage(template: string, vars: TemplateVars): string {
  return renderTemplate(template, vars).replace(/\r\n?/g, "\n").trim();
}

/**
 * How wide each character prints, in thousandths of the font size: Helvetica's widths (Arial's are
 * the same, as are the fonts made to stand in for them), for the space to the tilde. Anything else
 * (an accent, a dash, an emoji) is counted a whole em, which none of them is wider than.
 */
// prettier-ignore
const CHAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];
/**
 * Lob prints with WebKit and doesn't say which fonts it has. If neither Helvetica nor Arial is there
 * the stand-in sans-serif can run wider (DejaVu Sans is about an eighth wider), so every line is
 * measured as if it did: a message that fits here fits there.
 */
const WIDTH_SAFETY = 1.15;

const charWidth = (ch: string, fontIn: number) => {
  const code = ch.codePointAt(0) ?? 0;
  return ((code >= 32 && code <= 126 ? CHAR_WIDTHS[code - 32]! : 1000) / 1000) * fontIn * WIDTH_SAFETY;
};

export interface BackFit {
  fits: boolean;
  /** How many lines the words take. */
  lines: number;
  /** How many of them run past the bottom of the card (0 when it fits). */
  over: number;
}

/**
 * Whether a message, as one client's card says it (merge fields filled in), fits the back at this
 * size, laid out as backHtml lays it out: wrapped a word at a time into lines the box's full width
 * above Lob's address block and the narrower width beside it, a word longer than a line broken
 * where the line ends, with the gap after each paragraph. Measured rather than counted in
 * characters, because a card whose words don't fit is cut off at the bottom when it's printed.
 */
export function backFit(size: PostcardSize, message: string): BackFit {
  const box = backLayout(size);
  const space = charWidth(" ", box.fontIn);
  let y = 0;
  let lines = 0;
  // A line that reaches down past where the block starts is one of the narrow ones.
  const room = () => (y + box.lineIn > box.aboveBlock + 1e-6 ? box.besideBlock : box.width);
  const endLine = () => {
    y += box.lineIn;
    lines++;
  };
  message.trim().split(/\n{2,}/).forEach((paragraph, index) => {
    if (index) y += box.paragraphGapIn;
    for (const typed of paragraph.trim().split("\n")) {
      let used = 0;
      for (const word of typed.trim().split(/\s+/).filter(Boolean)) {
        const width = [...word].reduce((sum, ch) => sum + charWidth(ch, box.fontIn), 0);
        if (used > 0 && used + space + width <= room()) {
          used += space + width;
          continue;
        }
        if (used > 0) {
          endLine();
          used = 0;
        }
        if (width <= room()) {
          used = width;
          continue;
        }
        for (const ch of word) {
          const w = charWidth(ch, box.fontIn);
          if (used > 0 && used + w > room()) {
            endLine();
            used = 0;
          }
          used += w;
        }
      }
      endLine();
    }
  });
  const over = Math.max(0, Math.ceil((y - box.height) / box.lineIn - 1e-6));
  return { fits: over === 0, lines, over };
}

/** Why a card's message can't be printed, or null. `message` is the words as a client's card says them. */
export function messageProblem(message: string, size: PostcardSize): string | null {
  const text = message.trim();
  if (text.length < 10) return "Write the message for the back of the card.";
  const fit = backFit(size, text);
  if (!fit.fits) return `The message is about ${fit.over} ${fit.over === 1 ? "line" : "lines"} too long for the back of a ${POSTCARD_SIZE_INFO[size].label} card. Shorten it or pick a bigger card.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Mailing addresses
// ---------------------------------------------------------------------------------------------

export interface MailingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: "US";
}

type LooseAddress = { line1?: unknown; line2?: unknown; city?: unknown; region?: unknown; state?: unknown; postal_code?: unknown; zip?: unknown; country?: unknown } | null | undefined;

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const US = new Set(["", "us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"]);
/** A US ZIP code, five digits or ZIP+4. */
export const ZIP = /^\d{5}(-?\d{4})?$/;

/**
 * Why an address can't be mailed to ("no_address", "outside_us"), or the address. Complete is a
 * street, a city, a state and a US ZIP code; a blank country is the US, as everywhere in the app.
 */
export function mailable(address: LooseAddress): MailingAddress | "no_address" | "outside_us" {
  const line1 = text(address?.line1);
  const city = text(address?.city);
  const region = text(address?.region) || text(address?.state);
  const zip = text(address?.postal_code) || text(address?.zip);
  if (!line1 || !city || !region || !zip) return "no_address";
  if (!US.has(text(address?.country).toLowerCase()) || !ZIP.test(zip)) return "outside_us";
  return { line1, line2: text(address?.line2) || null, city, region, postal_code: zip, country: "US" };
}

/** Where a client's card goes: their billing address when it's complete, else their first property's that is. */
export function mailingAddress(billing: LooseAddress, properties: ReadonlyArray<LooseAddress>): MailingAddress | "no_address" | "outside_us" {
  let problem: "no_address" | "outside_us" = "no_address";
  for (const address of [billing, ...properties]) {
    const found = mailable(address);
    if (typeof found === "object") return found;
    if (found === "outside_us") problem = found;
  }
  return problem;
}

/** Why a client in the segment doesn't get a card, in the order they're counted. */
export const LEFT_OUT = ["archived", "opted_out", "no_address", "outside_us"] as const;
export type LeftOut = (typeof LEFT_OUT)[number];
export const LEFT_OUT_WORDS: Record<LeftOut, string> = {
  archived: "archived",
  opted_out: "opted out of marketing",
  no_address: "no complete mailing address",
  outside_us: "an address outside the US",
};

/** "12 left out: 8 with no complete mailing address, 3 opted out of marketing, 1 archived", or null with none. */
export function leftOutLine(counts: Partial<Record<LeftOut, number>>): string | null {
  const parts = LEFT_OUT.filter((k) => (counts[k] ?? 0) > 0).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  if (!parts.length) return null;
  const total = parts.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
  const words = parts.map((k) => `${(counts[k] ?? 0).toLocaleString("en-US")} ${k === "archived" || k === "opted_out" ? LEFT_OUT_WORDS[k] : `with ${LEFT_OUT_WORDS[k]}`}`);
  return `${total.toLocaleString("en-US")} left out: ${words.join(", ")}`;
}

/** An address on one line: "12 Oak St, Apt 2, Springfield, IL 62701". */
export const addressLine = (a: Pick<MailingAddress, "line1" | "line2" | "city" | "region" | "postal_code">) =>
  [a.line1, a.line2, a.city, `${a.region} ${a.postal_code}`.trim()].filter(Boolean).join(", ");

// ---------------------------------------------------------------------------------------------
// What Lob prints
// ---------------------------------------------------------------------------------------------

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const page = (size: PostcardSize, style: string, body: string) => {
  const { width, height } = artboard(size);
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}in;height:${height}in;overflow:hidden}${style}</style></head><body>${body}</body></html>`;
};

/** The front: the picture, filling the card to past its edges. */
export function frontHtml(size: PostcardSize, imageUrl: string): string {
  return page(size, `body{background:#fff url("${escapeHtml(imageUrl)}") center/cover no-repeat}`, "");
}

export interface BackInput {
  size: PostcardSize;
  message: string;
}

/**
 * The back: the message, a quarter inch inside the cut edge, with Lob's address block cut out of
 * its bottom right corner (backLayout), so the words run the full width above the block and down
 * its left side and can never be under it. Two floats on the right make the cut: one of no width
 * as high as the room above the block, and under it one the size of the block and its gap. Lob
 * prints the business's return address in that block itself (the card's `from`), so it isn't
 * printed here as well. What doesn't fit is cut off at the box's bottom, which is why a card is
 * only made once backFit says its words fit.
 */
export function backHtml({ size, message }: BackInput): string {
  const info = POSTCARD_SIZE_INFO[size];
  const box = backLayout(size);
  const paragraphs = message
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const style = [
    "body{background:#fff;color:#1d1d1b;font-family:Helvetica,Arial,sans-serif}",
    `.message{position:absolute;left:${box.left}in;top:${box.top}in;width:${box.width}in;height:${box.height}in;overflow:hidden;overflow-wrap:anywhere;font-size:${info.fontPt}pt;line-height:${LINE_HEIGHT}}`,
    `.above{float:right;width:0;height:${box.aboveBlock}in}`,
    `.block{float:right;clear:right;width:${box.cutWidth}in;height:${box.cutHeight}in}`,
    `.message p{margin:0 0 ${PARAGRAPH_GAP_EM}em}`,
  ].join("");
  return page(size, style, `<div class="message"><div class="above"></div><div class="block"></div>${paragraphs}</div>`);
}
