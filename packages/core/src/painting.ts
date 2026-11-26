/**
 * Painting: what belongs to a painting business and to no other trade. The gate is the company's
 * trade preset — painting surfaces check `isPaintingTrade` and nothing else, so a landscaping
 * company renders none of them and runs none of their code paths. (Phases 2–4 add the products
 * table, the room-by-room math and the packages here; see docs/painting.md.)
 */

/** The painting trade preset's id (companies.trade_preset, presets/painting.json). */
export const PAINTING_TRADE = "painting";

/** Whether this company is a painting business, by the trade it chose at setup. */
export const isPaintingTrade = (tradePreset: string | null | undefined): boolean => tradePreset === PAINTING_TRADE;

/**
 * What a business calls the document it sends a client to approve: a painting business sends a
 * "Proposal", everyone else a "Quote". A label layer only — the tables, routes and URLs stay
 * `quotes` whatever the trade. `plural` for lists and headings ("Proposals").
 */
export function docWord(tradePreset: string | null | undefined, plural = false): string {
  if (isPaintingTrade(tradePreset)) return plural ? "Proposals" : "Proposal";
  return plural ? "Quotes" : "Quote";
}
