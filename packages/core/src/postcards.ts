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
 * Each size as mailed, wide side across, in inches, with the most a message on the back can say.
 * Lob names them height by width ("4x6" is 6 in across and 4 in high).
 */
export const POSTCARD_SIZE_INFO: Record<PostcardSize, { width: number; height: number; label: string; maxMessage: number; fontPt: number }> = {
  "4x6": { width: 6, height: 4, label: "4 × 6 in", maxMessage: 500, fontPt: 10 },
  "6x9": { width: 9, height: 6, label: "6 × 9 in", maxMessage: 1000, fontPt: 12 },
  "6x11": { width: 11, height: 6, label: "6 × 11 in", maxMessage: 1300, fontPt: 12 },
};

/**
 * Where Lob prints the address, barcode and postage on the back: kept clear of ink, at the bottom
 * right. Lob's templates give 4 × 2⅜ in or a little less on every size; the message keeps out of a
 * column this wide on the right instead, so nothing it says can run under the address whatever its
 * length. One place to change if Lob's templates differ.
 */
export const ADDRESS_ZONE_IN = { width: 3.6, height: 2.6 };

/** A card's size with its bleed, as Lob takes the artwork. */
export const artboard = (size: PostcardSize) => ({ width: POSTCARD_SIZE_INFO[size].width + 2 * BLEED_IN, height: POSTCARD_SIZE_INFO[size].height + 2 * BLEED_IN });

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

/** Why a card's message can't be printed, or null. */
export function messageProblem(message: string, size: PostcardSize): string | null {
  const text = message.trim();
  if (text.length < 10) return "Write the message for the back of the card.";
  const max = POSTCARD_SIZE_INFO[size].maxMessage;
  if (text.length > max) return `The back of a ${POSTCARD_SIZE_INFO[size].label} card fits about ${max} characters. Shorten the message or pick a bigger card.`;
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
  /** The company's name and address, printed at the top left as the return address. */
  returnAddress: { name: string; line: string };
}

/**
 * The back: the return address at the top left, the message under it, and the right side left
 * clear for the address and postage Lob prints. Inside the cut edge by a quarter inch everywhere.
 */
export function backHtml({ size, message, returnAddress }: BackInput): string {
  const info = POSTCARD_SIZE_INFO[size];
  const inset = BLEED_IN + 0.25;
  const column = info.width - ADDRESS_ZONE_IN.width - 0.5;
  const paragraphs = message
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const style = [
    "body{background:#fff;color:#1d1d1b;font-family:Helvetica,Arial,sans-serif}",
    `.from{position:absolute;left:${inset}in;top:${inset}in;width:${column}in;font-size:${Math.max(7, info.fontPt - 3)}pt;line-height:1.3;color:#555}`,
    ".from strong{display:block;color:#1d1d1b}",
    `.message{position:absolute;left:${inset}in;top:${inset + 0.55}in;width:${column}in;bottom:${inset}in;overflow:hidden;font-size:${info.fontPt}pt;line-height:1.35}`,
    ".message p{margin:0 0 0.6em}",
  ].join("");
  const from = `<div class="from"><strong>${escapeHtml(returnAddress.name)}</strong>${escapeHtml(returnAddress.line)}</div>`;
  return page(size, style, `${from}<div class="message">${paragraphs}</div>`);
}
