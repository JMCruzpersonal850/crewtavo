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

// ---------- Rooms and the proposal's own words (phase 3) ----------

/**
 * A line's room, from quote_line_items.paint_detail: the room or area the line belongs to on
 * the proposal ("Exterior", "Master Bedroom") and the dimensions its card shows
 * (52' × 52' × 8'). The room lives on the line, the way Lead Control's rooms hold their
 * services: renaming a room rewrites the lines that say it, and a room with no lines in it
 * isn't stored anywhere. Null outside painting and on lines in no room.
 */
export interface PaintDetail {
  room: string | null;
  dimensions: string | null;
}

const detailText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Read a stored paint_detail; anything malformed reads as no room. */
export function paintDetailFrom(raw: unknown): PaintDetail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { room: null, dimensions: null };
  const o = raw as Record<string, unknown>;
  return { room: detailText(o.room), dimensions: detailText(o.dimensions) };
}

/** The stored shape for a line's room (null when the line is in no room). */
export function paintDetailJson(detail: PaintDetail): { room: string; dimensions?: string } | null {
  if (!detail.room) return null;
  return detail.dimensions ? { room: detail.room, dimensions: detail.dimensions } : { room: detail.room };
}

/** A room's measured size in feet, as the one-screen builder asks for it: length × width × height. */
export interface PaintAreaFeet {
  l: number;
  w: number;
  h: number;
}

/**
 * What the one-screen area builder adds to a line's paint_detail beside the room: the coats
 * that surface takes (the math panel reads it over its own coats pick, so the panel and the
 * builder agree) and the room's measured feet, so reopening the area shows the numbers it was
 * built from. Phase 3's readers ignore both keys — they ride along untouched through copies,
 * packages and the client page, which only ever read the room and its dimensions.
 */
export interface PaintAreaDetail {
  coats: number | null;
  feet: PaintAreaFeet | null;
}

const feetFrom = (v: unknown): PaintAreaFeet | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
  const l = n(o.l);
  const w = n(o.w);
  const h = n(o.h);
  return l !== null && w !== null && h !== null ? { l, w, h } : null;
};

/** Read a line's builder detail (coats, measured feet); anything malformed reads as unset. */
export function paintAreaDetailFrom(raw: unknown): PaintAreaDetail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { coats: null, feet: null };
  const o = raw as Record<string, unknown>;
  const coats = typeof o.coats === "number" && Number.isFinite(o.coats) && o.coats > 0 ? Math.round(o.coats) : null;
  return { coats, feet: feetFrom(o.feet) };
}

/** The stored shape for a line written by the area builder: its room detail plus its coats and feet. */
export function paintAreaDetailJson(
  detail: PaintDetail,
  area: PaintAreaDetail,
): { room: string; dimensions?: string; coats?: number; feet?: PaintAreaFeet } | null {
  const base = paintDetailJson(detail);
  if (!base) return null;
  return {
    ...base,
    ...(area.coats ? { coats: area.coats } : {}),
    ...(area.feet ? { feet: area.feet } : {}),
  };
}

/** A room's dimensions as its card shows them, from its measured feet: 52' × 52' × 8'. */
export function paintDimensionsText(feet: PaintAreaFeet): string {
  const n = (x: number) => String(Math.round(x * 100) / 100);
  return `${n(feet.l)}' × ${n(feet.w)}' × ${n(feet.h)}'`;
}

/**
 * The proposal's own words for its client page, from quotes.paint_presentation: the Overall
 * Scope of Work paragraph, the Job Notes, and the What's Included checklist — the pieces a
 * proposal carries beyond its lines. quotes.message stays what it is (the note over the
 * lines); a piece left out here falls back to what the proposal already carries — the lines'
 * descriptions for the scope, the message for the notes, a picked package's highlights for
 * the checklist (the fallbacks live where the page is built, in the web's hub document).
 */
export interface PaintPresentation {
  scope: string | null;
  notes: string | null;
  highlights: string[];
}

/** Read a stored paint_presentation; anything malformed reads as unwritten. */
export function paintPresentationFrom(raw: unknown): PaintPresentation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { scope: null, notes: null, highlights: [] };
  const o = raw as Record<string, unknown>;
  const highlights = Array.isArray(o.highlights)
    ? o.highlights.filter((h): h is string => typeof h === "string" && !!h.trim()).map((h) => h.trim())
    : [];
  return { scope: detailText(o.scope), notes: detailText(o.notes), highlights };
}

/** One room's lines, in the order they were written. */
export interface PaintRoomGroup<T> {
  /** The room's name; null for the lines in no room. */
  room: string | null;
  /** The room's dimensions, from the first of its lines that carries them. */
  dimensions: string | null;
  lines: T[];
}

/**
 * Group lines by their room, in first-written order — the Detailed Scope of Work's room
 * cards on the client page and the room blocks in the builder. Lines in no room gather into
 * one null group where the first of them sits.
 */
export function paintRoomGroups<T extends { paint_detail?: unknown }>(lines: readonly T[]): PaintRoomGroup<T>[] {
  const groups: PaintRoomGroup<T>[] = [];
  const byRoom = new Map<string | null, PaintRoomGroup<T>>();
  for (const line of lines) {
    const detail = paintDetailFrom(line.paint_detail);
    let group = byRoom.get(detail.room);
    if (!group) {
      group = { room: detail.room, dimensions: detail.dimensions, lines: [] };
      byRoom.set(detail.room, group);
      groups.push(group);
    }
    if (group.dimensions == null && detail.dimensions) group.dimensions = detail.dimensions;
    group.lines.push(line);
  }
  return groups;
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

/* ------------------------------------------------------------------------------------------
 * The one-screen area builder (phase 3's remainder): Josue's way of building a proposal —
 * pick an area, say how big it is once, tap the surfaces in it on or off, and watch the room
 * price itself. No add-a-surface screens: the area's surfaces are its price-book services,
 * their quantities come from the room's feet, and the lines it writes are ordinary quote
 * lines carrying the room in paint_detail, so the line list, the math panel, the packages
 * and the client page all read them exactly as they read any other line. The rates are the
 * price book's; coats drive the paint (quantity × coats ÷ coverage, rounded up per room,
 * the math above) — a surface's line price is its quantity at its rate, the way the price
 * book already prices every line in the builder.
 * ---------------------------------------------------------------------------------------- */

/** Which side of the house an area is on; its surfaces and presets follow it. */
export type PaintAreaScope = "interior" | "exterior";

/** The areas Josue picks from, interior first — his Lead Control rooms, plus a free name. */
export const INTERIOR_AREA_PRESETS = [
  "Master bedroom", "Bedroom", "Living room", "Kitchen", "Bathroom", "Dining room",
  "Hallway", "Office", "Laundry room", "Closet", "Ceiling only",
] as const;

/** Exterior areas: a whole house, or one side of it at a time. */
export const EXTERIOR_AREA_PRESETS = [
  "Whole house", "Front", "Back", "Left side", "Right side", "Porch", "Garage",
] as const;

/** The area presets for a scope, in the order the chips show them. */
export const paintAreaPresets = (scope: PaintAreaScope): readonly string[] =>
  scope === "interior" ? INTERIOR_AREA_PRESETS : EXTERIOR_AREA_PRESETS;

/** A preset that starts from a narrower set of surfaces than the usual walls + ceiling + trim. */
export const PAINT_AREA_PRESET_SURFACES: Readonly<Record<string, readonly string[]>> = {
  "Ceiling only": ["ceiling"],
};

/** How a surface's quantity comes from the room: its walls, its ceiling, its perimeter, or a count typed for it. */
export type PaintMeasure = "walls" | "ceiling" | "perimeter" | "count";

export interface PaintSurfaceDef {
  /** The surface's key in a draft ("walls", "baseboards", "frontDoor"). */
  key: string;
  /** What the toggle says. */
  label: string;
  scope: PaintAreaScope;
  /** The price-book category its service sits in. */
  category: "Interior" | "Exterior";
  /**
   * Its price-book services by variant key — one entry ("default") for most surfaces; the
   * baseboards carry their two sizes ("3", "5"). A surface whose service a company doesn't
   * have (renamed, never seeded) can't be priced: the builder shows it off, not broken.
   */
  services: Readonly<Record<string, string>>;
  measure: PaintMeasure;
  /** Painted surfaces ask for coats (the steppers); per-piece surfaces (a door, shutters) ask for a count. */
  coats: boolean;
}

/** The interior surfaces, in the order they show: the big areas, the trim work, the pieces. */
export const INTERIOR_SURFACES: readonly PaintSurfaceDef[] = [
  { key: "walls", label: "Walls", scope: "interior", category: "Interior", services: { default: "Interior walls" }, measure: "walls", coats: true },
  { key: "ceiling", label: "Ceiling", scope: "interior", category: "Interior", services: { default: "Ceilings" }, measure: "ceiling", coats: true },
  { key: "trim", label: "Trim", scope: "interior", category: "Interior", services: { default: "Trim" }, measure: "perimeter", coats: true },
  { key: "baseboards", label: "Baseboards", scope: "interior", category: "Interior", services: { "3": "Baseboards, 3 in", "5": "Baseboards, 5 in" }, measure: "perimeter", coats: true },
  { key: "windowTrim", label: "Window trim", scope: "interior", category: "Interior", services: { default: "Window trim" }, measure: "count", coats: false },
  { key: "doors", label: "Doors", scope: "interior", category: "Interior", services: { default: "Doors" }, measure: "count", coats: false },
];

/** The exterior surfaces: the walls and the trim work measured off the house, the pieces counted. */
export const EXTERIOR_SURFACES: readonly PaintSurfaceDef[] = [
  { key: "extWalls", label: "Walls & siding", scope: "exterior", category: "Exterior", services: { default: "Exterior walls and siding" }, measure: "walls", coats: true },
  { key: "extTrim", label: "Exterior trim", scope: "exterior", category: "Exterior", services: { default: "Exterior trim" }, measure: "perimeter", coats: true },
  { key: "fascia", label: "Fascia", scope: "exterior", category: "Exterior", services: { default: "Fascia" }, measure: "perimeter", coats: true },
  { key: "shutters", label: "Shutters", scope: "exterior", category: "Exterior", services: { default: "Shutters" }, measure: "count", coats: false },
  { key: "frontDoor", label: "Front door", scope: "exterior", category: "Exterior", services: { default: "Front door" }, measure: "count", coats: false },
  { key: "garageDoor", label: "Garage door", scope: "exterior", category: "Exterior", services: { default: "Garage door" }, measure: "count", coats: false },
];

/** A scope's surfaces, in the order they show. */
export const paintSurfacesFor = (scope: PaintAreaScope): readonly PaintSurfaceDef[] =>
  scope === "interior" ? INTERIOR_SURFACES : EXTERIOR_SURFACES;

/**
 * The door kinds the picker offers. A door is priced per slab in the price book, so a kind
 * that paints two slabs (a double door, French doors) counts as two doors on the line; the
 * kind rides in the line's description, where the client reads it.
 */
export const PAINT_DOOR_TYPES = [
  { key: "single", label: "Interior door", slabs: 1 },
  { key: "double", label: "Double door", slabs: 2 },
  { key: "french", label: "French doors", slabs: 2 },
] as const;

export const paintDoorType = (key: string): (typeof PAINT_DOOR_TYPES)[number] =>
  PAINT_DOOR_TYPES.find((d) => d.key === key) ?? PAINT_DOOR_TYPES[0];

/** The measured quantities of a room in feet: its wall area, its ceiling, its way around. */
export function paintAreaQuantities(feet: PaintAreaFeet): { walls: number; ceiling: number; perimeter: number } {
  const perimeter = 2 * (feet.l + feet.w);
  return { walls: round2(perimeter * feet.h), ceiling: round2(feet.l * feet.w), perimeter: round2(perimeter) };
}

/** One surface as the person quoting left it: on or off, its coats, its count, its variant. */
export interface PaintAreaSurfaceState {
  on: boolean;
  coats: number;
  count: number;
  /** The chosen service variant ("3" / "5" for baseboards); "default" where there's one service. */
  variant: string;
}

/** One area being built on the one screen: its scope, its name, its size, its surfaces, its prep. */
export interface PaintAreaDraft {
  scope: PaintAreaScope;
  room: string;
  /** The room's feet; null until they're typed (measured surfaces can't price without them). */
  feet: PaintAreaFeet | null;
  surfaces: Record<string, PaintAreaSurfaceState>;
  /** The Doors surface's kind (PAINT_DOOR_TYPES key); interior areas only. */
  doorType: string;
  /** Prep as one fixed amount for the area, the RollerQuote way — a flat line, no paint in it. */
  prep: { on: boolean; amount: number };
}

const surfaceState = (def: PaintSurfaceDef): PaintAreaSurfaceState => ({
  on: def.measure !== "count" && def.key !== "baseboards",
  coats: 2,
  count: 1,
  variant: Object.keys(def.services)[0] ?? "default",
});

/** A fresh area draft for a scope: measured surfaces on at two coats, counts off, prep off. */
export function emptyPaintAreaDraft(scope: PaintAreaScope, room = ""): PaintAreaDraft {
  const surfaces: Record<string, PaintAreaSurfaceState> = {};
  for (const def of paintSurfacesFor(scope)) surfaces[def.key] = surfaceState(def);
  return { scope, room, feet: null, surfaces, doorType: "single", prep: { on: false, amount: 0 } };
}

/** A price-book service, as much of it as the area builder reads. */
export interface PaintAreaService {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  unit_price: number;
  unit_cost?: number | null;
  taxable: boolean;
}

/** The service a surface writes, for its chosen variant — null when the company doesn't carry it. */
export function paintAreaServiceFor(
  def: PaintSurfaceDef,
  variant: string,
  services: readonly PaintAreaService[],
): PaintAreaService | null {
  const name = def.services[variant] ?? def.services[Object.keys(def.services)[0] ?? "default"];
  if (!name) return null;
  return services.find((s) => s.name === name && s.category === def.category) ?? null;
}

/** Every service id the area builder manages for a scope — how a save knows which of a room's lines are its own. */
export function paintAreaManagedServiceIds(scope: PaintAreaScope, services: readonly PaintAreaService[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const def of paintSurfacesFor(scope)) {
    for (const variant of Object.keys(def.services)) {
      const service = paintAreaServiceFor(def, variant, services);
      if (service) ids.add(service.id);
    }
  }
  return ids;
}

/** The name the prep line carries — how a save (and the draft reader) knows a room's flat line is its prep. */
export const PAINT_PREP_LINE_NAME = "Prep";

/** Whether a room's line is the area builder's prep line: no service behind it, named Prep. */
export const isPaintPrepLine = (line: { service_id?: string | null; name: string }): boolean =>
  !line.service_id && line.name === PAINT_PREP_LINE_NAME;

/** One line the area builder writes: an ordinary quote line, its room in paint_detail. */
export interface PaintAreaLine {
  /** The surface's key, or "prep". */
  key: string;
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  paint_detail: { room: string; dimensions?: string; coats?: number; feet?: PaintAreaFeet } | null;
}

/** One row of the live breakdown: what a surface measures, its rate, what it comes to, the paint it takes. */
export interface PaintAreaBreakdownRow {
  key: string;
  label: string;
  quantity: number;
  unit: string;
  /** The price-book rate the line writes. */
  rate: number;
  total: number;
  /** The surface's coats, where it takes coats; null for per-piece surfaces and prep. */
  coats: number | null;
  /** This surface's share of its room's rounded-up gallons, from the proposal math. */
  gallons: number;
  /** On in the draft but unpriceable — its service isn't in the company's price book. */
  missing: boolean;
}

export interface PaintAreaBuild {
  lines: PaintAreaLine[];
  breakdown: PaintAreaBreakdownRow[];
  /** What the room's lines come to — the room total the screen shows. */
  roomTotal: number;
  /** Whole gallons the room's paint comes to, per product key — the math's count. */
  gallonsByProduct: Record<string, number>;
}

/**
 * The product a surface drinks from, the way the math panel picks it: trim paint for a
 * linear-foot surface, the scope's first product for the rest. (The panel lets the office
 * pick between a scope's products; the one screen takes the first, as the panel does until
 * it's told otherwise.)
 */
function areaProductFor(
  scope: PaintAreaScope,
  unit: string,
  products: readonly (PaintProduct & { key: string })[],
): (PaintProduct & { key: string }) | null {
  if (unit === "ft") return products.find((p) => p.scope === "trim") ?? null;
  return products.find((p) => p.scope === scope) ?? null;
}

/**
 * Build an area's lines and its live breakdown from a draft. Pure: the screen runs it on
 * every tap, and a save writes `lines` as they stand. The gallons run through the proposal
 * math with the panel's own inputs (per-piece surfaces carry their price-book cost as a flat
 * fee and drink nothing; measured surfaces drink their product), so the room's gallons here
 * are the panel's gallons for the same lines.
 */
export function buildPaintArea(
  draft: PaintAreaDraft,
  services: readonly PaintAreaService[],
  settings: PaintSettings,
  products: readonly (PaintProduct & { key: string })[],
): PaintAreaBuild {
  const room = draft.room.trim();
  const quantities = draft.feet ? paintAreaQuantities(draft.feet) : null;
  const detail = (coats: number | null) =>
    room
      ? paintAreaDetailJson(
          { room, dimensions: draft.feet ? paintDimensionsText(draft.feet) : null },
          { coats, feet: draft.feet },
        )
      : null;

  const lines: PaintAreaLine[] = [];
  const breakdown: PaintAreaBreakdownRow[] = [];
  const inputs: PaintSurfaceInput[] = [];
  const inputRows: PaintAreaBreakdownRow[] = [];

  for (const def of paintSurfacesFor(draft.scope)) {
    const state = draft.surfaces[def.key];
    if (!state?.on) continue;
    const service = paintAreaServiceFor(def, state.variant, services);
    if (!service) {
      breakdown.push({ key: def.key, label: def.label, quantity: 0, unit: "", rate: 0, total: 0, coats: def.coats ? state.coats : null, gallons: 0, missing: true });
      continue;
    }
    const slabs = def.key === "doors" ? paintDoorType(draft.doorType).slabs : 1;
    const quantity =
      def.measure === "count"
        ? Math.max(0, Math.round(state.count)) * slabs
        : quantities
          ? quantities[def.measure]
          : 0;
    const row: PaintAreaBreakdownRow = {
      key: def.key,
      label: def.label,
      quantity,
      unit: service.unit,
      rate: Number(service.unit_price),
      total: round2(quantity * Number(service.unit_price)),
      coats: def.coats ? state.coats : null,
      gallons: 0,
      missing: false,
    };
    breakdown.push(row);
    if (quantity <= 0) continue;
    lines.push({
      key: def.key,
      service_id: service.id,
      name: service.name,
      description: def.key === "doors" && slabs > 1 ? paintDoorType(draft.doorType).label : null,
      quantity,
      unit: service.unit,
      unit_price: Number(service.unit_price),
      unit_cost: service.unit_cost != null ? Number(service.unit_cost) : null,
      taxable: service.taxable,
      paint_detail: detail(def.coats ? state.coats : null),
    });
    // The math's inputs for this surface, the panel's way: a per-piece surface is a flat fee
    // at its price-book cost and drinks nothing; a measured one drinks its product.
    if (service.unit === "ea" || service.unit === "visit" || service.unit === "job") {
      inputs.push({ room, scope: def.scope === "interior" ? "interior" : "exterior", quantity, product: null, flatFeePerUnit: service.unit_cost != null ? Number(service.unit_cost) : null });
    } else {
      inputs.push({
        room,
        scope: def.scope === "interior" ? "interior" : "exterior",
        quantity,
        coats: def.coats ? state.coats : 2,
        product: areaProductFor(def.scope, service.unit, products),
      });
    }
    inputRows.push(row);
  }

  if (draft.prep.on && draft.prep.amount > 0) {
    const amount = round2(draft.prep.amount);
    breakdown.push({ key: "prep", label: "Prep", quantity: 1, unit: "ea", rate: amount, total: amount, coats: null, gallons: 0, missing: false });
    lines.push({
      key: "prep",
      service_id: null,
      name: PAINT_PREP_LINE_NAME,
      description: null,
      quantity: 1,
      unit: "ea",
      unit_price: amount,
      unit_cost: null,
      taxable: true,
      paint_detail: detail(null),
    });
  }

  const math = paintProposalMath(inputs, settings);
  inputs.forEach((_, i) => {
    inputRows[i]!.gallons = Math.round(math.surfaces[i]!.gallons * 10) / 10;
  });
  return {
    lines,
    breakdown,
    roomTotal: round2(lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0)),
    gallonsByProduct: math.gallonsByProduct,
  };
}

/** A stored line, as much of it as the draft reader reads. */
export interface PaintAreaStoredLine {
  service_id?: string | null;
  name: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  paint_detail?: unknown;
}

const FEET_TEXT = /([\d.]+)\s*['′]?\s*[×x]\s*([\d.]+)\s*['′]?\s*[×x]\s*([\d.]+)/;

/** A room's feet from a stored line: the builder's own feet when it wrote them, else its dimensions text read back. */
function storedFeet(lines: readonly PaintAreaStoredLine[]): PaintAreaFeet | null {
  for (const line of lines) {
    const feet = paintAreaDetailFrom(line.paint_detail).feet;
    if (feet) return feet;
  }
  for (const line of lines) {
    const dims = paintDetailFrom(line.paint_detail).dimensions;
    const match = dims ? FEET_TEXT.exec(dims) : null;
    if (match) {
      const feet = { l: Number(match[1]), w: Number(match[2]), h: Number(match[3]) };
      if (feet.l > 0 && feet.w > 0 && feet.h > 0) return feet;
    }
  }
  return null;
}

/**
 * Read an area back from its stored lines — reopening a room in the builder shows the
 * surfaces, coats and counts it was saved with. The scope comes from its services'
 * categories; a room whose lines the builder doesn't manage (a custom item someone added)
 * keeps those lines untouched and reads as just its managed surfaces. Null when none of
 * the room's lines are the builder's.
 */
export function paintAreaDraftFromLines(
  room: string,
  lines: readonly PaintAreaStoredLine[],
  services: readonly PaintAreaService[],
): PaintAreaDraft | null {
  const byId = new Map(services.map((s) => [s.id, s]));
  let scope: PaintAreaScope | null = null;
  for (const line of lines) {
    const service = line.service_id ? byId.get(line.service_id) : null;
    if (service?.category === "Interior") scope = "interior";
    if (service?.category === "Exterior") scope = "exterior";
    if (scope) break;
  }
  const prepLine = lines.find((l) => isPaintPrepLine(l));
  if (!scope && !prepLine) return null;
  const draft = emptyPaintAreaDraft(scope ?? "interior", room);
  draft.feet = storedFeet(lines);
  draft.prep = prepLine ? { on: true, amount: Number(prepLine.unit_price) } : { on: false, amount: 0 };
  if (!scope) return draft;
  for (const def of paintSurfacesFor(scope)) draft.surfaces[def.key]!.on = false;
  for (const def of paintSurfacesFor(scope)) {
    for (const variant of Object.keys(def.services)) {
      const service = paintAreaServiceFor(def, variant, services);
      if (!service) continue;
      const line = lines.find((l) => l.service_id === service.id);
      if (!line) continue;
      const state = draft.surfaces[def.key]!;
      state.on = true;
      state.variant = variant;
      state.coats = paintAreaDetailFrom(line.paint_detail).coats ?? 2;
      if (def.key === "doors") {
        const type = PAINT_DOOR_TYPES.find((d) => d.label === line.description) ?? PAINT_DOOR_TYPES[0];
        draft.doorType = type.key;
        state.count = Math.max(1, Math.round(Number(line.quantity) / type.slabs));
      } else if (def.measure === "count") {
        state.count = Math.max(1, Math.round(Number(line.quantity)));
      }
      break;
    }
  }
  return draft;
}
