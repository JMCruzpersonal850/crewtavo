/**
 * Painting: what belongs to a painting business and to no other trade. The gate is the company's
 * trade preset — painting surfaces check `isPaintingTrade` and nothing else, so a landscaping
 * company renders none of them and runs none of their code paths. Phase 2 adds the company's
 * painting numbers (sub rates, labor, margin), the proposal math and the package seeds here;
 * the room-by-room builder is Phase 3 (see docs/painting.md).
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

/* ------------------------------------------------------------------------------------------
 * The company's painting numbers (Settings → Painting, stored at companies.settings.painting).
 * The defaults are Ocean Crest's, from the Lead Control blueprint: proposals price in
 * subcontractor mode (a sub is paid per unit), employee labor is $80/hr, materials carry a 30%
 * markup in employee mode, and the document takes its price from a target margin after a 15%
 * overhead allocation and a 2.5% warranty reserve.
 * ---------------------------------------------------------------------------------------- */

export interface PaintSettings {
  /** What a subcontractor is paid per unit on interior work (sq ft, lin ft). */
  subInteriorRate: number;
  /** What a subcontractor is paid per unit on exterior work (sq ft, lin ft, each). */
  subExteriorRate: number;
  /** Employee labor, per hour. */
  laborRate: number;
  /** The markup a product starts with, and materials take in employee mode. */
  materialMarkupPct: number;
  /** The gross margin the client price is set from: price = cost / (1 - margin). */
  defaultMarginPct: number;
  /** Overhead allocation, taken on direct cost before the margin. */
  overheadPct: number;
  /** Warranty reserve, taken on direct cost before the margin. */
  warrantyReservePct: number;
}

export const DEFAULT_PAINT_SETTINGS: PaintSettings = {
  subInteriorRate: 2,
  subExteriorRate: 5,
  laborRate: 80,
  materialMarkupPct: 30,
  defaultMarginPct: 30,
  overheadPct: 15,
  warrantyReservePct: 2.5,
};

const PAINT_SETTING_KEYS = Object.keys(DEFAULT_PAINT_SETTINGS) as Array<keyof PaintSettings>;

/** A stored settings.painting value read over the defaults: anything missing or not a number keeps the default. */
export function paintSettingsFrom(raw: unknown): PaintSettings {
  const out = { ...DEFAULT_PAINT_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const stored = raw as Record<string, unknown>;
  for (const key of PAINT_SETTING_KEYS) {
    const value = stored[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------
 * Products (the paint_products table): what a gallon costs, what it covers, and the markup it
 * carries. Coverage is per gallon in the surface's own unit — square feet for walls, linear
 * feet for trim — the same way Lead Control's snapshots record it.
 * ---------------------------------------------------------------------------------------- */

export type PaintScope = "interior" | "exterior" | "trim";

export interface PaintProduct {
  name: string;
  brand: string | null;
  scope: PaintScope;
  costPerGallon: number;
  markupPct: number;
  coveragePerGallon: number;
}

/**
 * The products Ocean Crest's proposals price with, from the blueprint's snapshots. ProClassic's
 * cost is the middle of what the snapshots show ($54.17–$55.89 a gallon, rounding varies by job).
 */
export const DEFAULT_PAINT_PRODUCTS: PaintProduct[] = [
  { name: "Interior Acrylic Latex", brand: null, scope: "interior", costPerGallon: 42, markupPct: 30, coveragePerGallon: 400 },
  { name: "Exterior Acrylic Latex", brand: null, scope: "exterior", costPerGallon: 48, markupPct: 30, coveragePerGallon: 320 },
  { name: "ProClassic Trim", brand: "Sherwin-Williams", scope: "trim", costPerGallon: 55, markupPct: 30, coveragePerGallon: 350 },
  { name: "Duration Exterior", brand: "Sherwin-Williams", scope: "exterior", costPerGallon: 48, markupPct: 30, coveragePerGallon: 350 },
];

/** What a gallon sells for: its cost with its markup on. */
export const productSellPerGallon = (p: Pick<PaintProduct, "costPerGallon" | "markupPct">): number =>
  round2(p.costPerGallon * (1 + p.markupPct / 100));

/* ------------------------------------------------------------------------------------------
 * The proposal math (Lead Control's room_subpricing_v2, verified against its proposals):
 * a surface's labor is quantity × the sub rate for its scope (or a flat fee per unit, or
 * hours × the labor rate in employee mode); its paint is quantity × coats / coverage, rounded
 * UP to whole gallons per room per product, because paint is bought per room and color; the
 * material cost is those gallons at the product's cost with its markup on. Overhead and the
 * warranty reserve come off the direct cost, and the client price is set from the margin:
 * price = total cost / (1 - margin). Pure: the quote builder (web) and the packages (api)
 * run the same numbers from the same inputs.
 * ---------------------------------------------------------------------------------------- */

export interface PaintSurfaceInput {
  /** The room the surface belongs to; gallons round up per room. Lines without one share a room. */
  room?: string | null;
  scope: PaintScope;
  quantity: number;
  /** Coats of paint; 2 unless the package or job says otherwise. */
  coats?: number;
  /** The product this surface is painted with; none: no material cost (flat-fee surfaces). */
  product?: (PaintProduct & { key: string }) | null;
  /** Per-unit sub rate override; the settings rate for the scope when left out. */
  subRate?: number | null;
  /** A flat fee per unit instead of a rate (a garage door, a downspout). */
  flatFeePerUnit?: number | null;
  /** Employee mode: hours per unit, priced at the labor rate, instead of a sub rate or fee. */
  laborHoursPerUnit?: number | null;
}

export interface PaintSurfaceMath {
  laborCost: number;
  /** Gallons before rounding: quantity × coats / coverage. */
  gallonsRaw: number;
  /** This surface's share of its room's rounded-up gallons. */
  gallons: number;
  materialCost: number;
  directCost: number;
  /** The client price this surface carries at the proposal's margin, and per unit of it. */
  priceTotal: number;
  unitPrice: number;
}

export interface PaintMath {
  surfaces: PaintSurfaceMath[];
  /** Whole gallons bought, per product key. */
  gallonsByProduct: Record<string, number>;
  laborCost: number;
  materialCost: number;
  directCost: number;
  overheadCost: number;
  warrantyReserveCost: number;
  totalCost: number;
  /** The client price at the margin, before tax and discounts. */
  price: number;
  profit: number;
  /** The margin the price actually makes: profit / price. */
  marginPct: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const subRateFor = (settings: PaintSettings, scope: PaintScope): number =>
  scope === "exterior" ? settings.subExteriorRate : settings.subInteriorRate;

/** One surface's labor and raw gallons, before the per-room gallon round-up. */
function surfaceParts(input: PaintSurfaceInput, settings: PaintSettings): { laborCost: number; gallonsRaw: number } {
  const qty = Math.max(0, input.quantity);
  const laborCost =
    input.flatFeePerUnit != null
      ? qty * input.flatFeePerUnit
      : input.laborHoursPerUnit != null
        ? qty * input.laborHoursPerUnit * settings.laborRate
        : qty * (input.subRate ?? subRateFor(settings, input.scope));
  const gallonsRaw = input.product && input.product.coveragePerGallon > 0 ? (qty * (input.coats ?? 2)) / input.product.coveragePerGallon : 0;
  return { laborCost: round2(laborCost), gallonsRaw };
}

/**
 * Price a set of surfaces the painting way. `marginPct` defaults to the settings' margin; the
 * builder passes its own when the person quoting adjusts it for this proposal.
 */
export function paintProposalMath(surfaces: readonly PaintSurfaceInput[], settings: PaintSettings, marginPct: number = settings.defaultMarginPct): PaintMath {
  const parts = surfaces.map((s) => surfaceParts(s, settings));
  // Gallons round up per room per product: group the raw gallons, then share each group's
  // rounded gallons (and their cost) back over its surfaces in proportion to the raw gallons.
  const groups = new Map<string, { raw: number; product: NonNullable<PaintSurfaceInput["product"]> }>();
  surfaces.forEach((s, i) => {
    if (!s.product || parts[i]!.gallonsRaw <= 0) return;
    const key = `${s.room ?? ""}${s.product.key}`;
    const group = groups.get(key) ?? { raw: 0, product: s.product };
    group.raw += parts[i]!.gallonsRaw;
    groups.set(key, group);
  });
  const gallonsByProduct: Record<string, number> = {};
  for (const group of groups.values()) {
    const key = group.product.key;
    gallonsByProduct[key] = (gallonsByProduct[key] ?? 0) + Math.ceil(group.raw);
  }

  const priced = surfaces.map((s, i) => {
    const { laborCost, gallonsRaw } = parts[i]!;
    let gallons = 0;
    let materialCost = 0;
    if (s.product && gallonsRaw > 0) {
      const group = groups.get(`${s.room ?? ""}${s.product.key}`)!;
      const rounded = Math.ceil(group.raw);
      gallons = group.raw > 0 ? (rounded * gallonsRaw) / group.raw : 0;
      materialCost = round2(gallons * s.product.costPerGallon * (1 + s.product.markupPct / 100));
    }
    return { laborCost, gallonsRaw, gallons, materialCost, directCost: round2(laborCost + materialCost), priceTotal: 0, unitPrice: 0 };
  });

  const laborCost = round2(priced.reduce((sum, s) => sum + s.laborCost, 0));
  const materialCost = round2(priced.reduce((sum, s) => sum + s.materialCost, 0));
  const directCost = round2(laborCost + materialCost);
  const overheadCost = round2(directCost * (settings.overheadPct / 100));
  const warrantyReserveCost = round2(directCost * (settings.warrantyReservePct / 100));
  const totalCost = round2(directCost + overheadCost + warrantyReserveCost);
  const margin = Math.min(Math.max(marginPct, 0), 99);
  const price = round2(totalCost / (1 - margin / 100));
  // Each surface carries the price in proportion to its direct cost, so the lines add to the price.
  priced.forEach((s, i) => {
    s.priceTotal = directCost > 0 ? round2((s.directCost / directCost) * price) : 0;
    const qty = Math.max(0, surfaces[i]!.quantity);
    s.unitPrice = qty > 0 ? round2(s.priceTotal / qty) : s.priceTotal;
  });
  const profit = round2(price - totalCost);
  return {
    surfaces: priced,
    gallonsByProduct,
    laborCost,
    materialCost,
    directCost,
    overheadCost,
    warrantyReserveCost,
    totalCost,
    price,
    profit,
    marginPct: price > 0 ? round2((profit / price) * 100) : 0,
  };
}
