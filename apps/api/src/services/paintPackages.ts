/**
 * Painting's products and Good / Better / Best packages (paint_products, paint_packages): seeded
 * from Ocean Crest's real Lead Control proposal templates (the blueprint,
 * workspace/lead-control-painting-blueprint.md §5, read back from Lead Control itself), and
 * offered on a proposal as options through the same quote_options the Client Hub picks and
 * signs from. A package paints the proposal's scope with its own product and coats: its lines
 * are the proposal's lines repriced by the painting math (core painting.ts) with the package's
 * product, plus the tier's markup — the DripJobs uplift Lead Control's templates carry.
 * Painting only: the routes refuse any company whose trade isn't painting before calling here.
 *
 * Nov 27, 2026: Josue changed Lead Control's exterior templates (2 and 6) — Better now paints
 * Sherwin-Williams Emerald Rain Refresh in the template itself (no longer a per-job swap like
 * the Griffis proposal's), Good names SuperPaint, and the exterior warranties stepped down to
 * Better 2 years / Best 3 years. The exterior seeds below follow those templates as they now
 * stand; the interior templates were not touched. Companies already seeded with the older
 * exterior rows are brought forward by resyncPaintPackageSeeds (setup), which rewrites only
 * rows that still match the previous seeds word for word — a package the office edited by
 * hand is theirs and stays.
 */
import type { Json } from "@crewtavo/core/database";
import { DEFAULT_PAINT_PRODUCTS, paintDetailFrom, paintProposalMath, paintSettingsFrom, type PaintProduct, type PaintScope, type PaintSurfaceInput } from "@crewtavo/core/painting";
import { dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { EDITABLE, lockedMessage } from "./roofPackages";

/* ------------------------------------------------------------------------------------------
 * The seeds: Ocean Crest's Lead Control packages, verbatim. Feature bullets lose only their
 * literal "• " prefixes (the option card draws its own), a tier's warranty bullet moves to the
 * warranty line, and Template 1 Good's first "feature" — the package's own label repeated — is
 * dropped. Products Lead Control names but never priced (SuperPaint, Emerald Interior,
 * Emerald Rain Refresh) stay names: product_id links only where the blueprint has a cost
 * (Duration Exterior).
 * ---------------------------------------------------------------------------------------- */

export interface PaintPackageSeed {
  set_name: string;
  name: string;
  tier: "good" | "better" | "best";
  scope: "interior" | "exterior";
  tagline: string;
  description: string;
  paint_grade: string | null;
  /** The paint_products row to link, by name, when its price is known. */
  product_link: string | null;
  product_name: string | null;
  coats: number;
  primer_coats: number;
  markup_pct: number;
  warranty_months: number;
  warranty: string;
  highlights: string[];
  is_enabled: boolean;
  is_default: boolean;
  sort: number;
}

export const PAINT_PACKAGE_SEEDS: PaintPackageSeed[] = [
  // Interior — Lead Control template 1, "Interior Painting: Standard / Premium / Ultimate".
  {
    set_name: "Interior Painting: Standard / Premium / Ultimate", name: "Good / Standard Package", tier: "good", scope: "interior",
    tagline: "Quality paint, professional finish", description: "SuperPaint — Good: Reliable coverage, durability, and a smooth finish for everyday living spaces.",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams Super Paint", coats: 2, primer_coats: 0,
    markup_pct: 5, warranty_months: 36, warranty: "3-year workmanship warranty",
    highlights: ["2 coats of Sherwin-Williams SuperPaint", "Standard surface prep: patching, sanding, and cleaning", "Professional application with quality brushes and rollers"],
    is_enabled: true, is_default: false, sort: 0,
  },
  {
    set_name: "Interior Painting: Standard / Premium / Ultimate", name: "Better / Premium — Recommended", tier: "better", scope: "interior",
    tagline: "Premium coverage, longer-lasting results", description: "Duration — Better: More washable and resistant to stains and everyday wear, making it better for busy homes.",
    paint_grade: "Premium", product_link: null, product_name: "Sherwin-Williams Duration", coats: 2, primer_coats: 0,
    markup_pct: 15, warranty_months: 36, warranty: "3-year workmanship warranty",
    highlights: ["2 coats of premium Sherwin-Williams Duration", "Improved washability and resistance to everyday wear", "Standard prep: minor patching, sanding, and cleaning", "Professional application", "Color consultation included"],
    is_enabled: true, is_default: true, sort: 1,
  },
  {
    set_name: "Interior Painting: Standard / Premium / Ultimate", name: "Best / Ultimate", tier: "best", scope: "interior",
    tagline: "Ultimate protection, flawless finish", description: "Emerald Interior — Best: Superior hide, washability, durability, and the smoothest premium finish of the three.",
    paint_grade: "Ultra-Premium", product_link: null, product_name: "Sherwin-Williams Emerald Interior", coats: 2, primer_coats: 0,
    markup_pct: 25, warranty_months: 36, warranty: "3-year workmanship warranty",
    highlights: ["2 coats of Sherwin-Williams Emerald Interior", "Premium finish with superior washability and durability", "Standard prep: minor patching, sanding, and cleaning", "Professional application", "Color consultation included"],
    is_enabled: true, is_default: false, sort: 2,
  },
  // Interior — Lead Control template 5, "Interior Painting (Standard Package)": only Good is on.
  {
    set_name: "Interior Painting (Standard Package)", name: "Good / Standard Package", tier: "good", scope: "interior",
    tagline: "Quality paint, professional finish", description: "",
    paint_grade: "Standard", product_link: null, product_name: null, coats: 2, primer_coats: 0,
    markup_pct: 0, warranty_months: 36, warranty: "3-year workmanship warranty",
    highlights: ["2 coats of Behr Interior Paint and Sherwin-Williams Emerald", "Eggshell sheen", "Surface preparation as needed", "Professional brush and roller application", "Colors: Behr BXC-62 Alabaster, SW 6479 Drizzle, SW 6437 Haven, and SW Light Blue"],
    is_enabled: true, is_default: true, sort: 3,
  },
  {
    set_name: "Interior Painting (Standard Package)", name: "Better", tier: "better", scope: "interior",
    tagline: "Premium coverage, longer-lasting results", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams Duration", coats: 2, primer_coats: 1,
    markup_pct: 15, warranty_months: 24, warranty: "2-year labor warranty",
    highlights: ["1 coat primer + 2 coats paint", "Full prep (spackle, sand, prime all patches)", "Premium Sherwin-Williams Duration", "Color consultation included"],
    is_enabled: false, is_default: false, sort: 4,
  },
  {
    set_name: "Interior Painting (Standard Package)", name: "Best", tier: "best", scope: "interior",
    tagline: "Ultimate protection, flawless finish", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams Emerald Interior", coats: 2, primer_coats: 0,
    markup_pct: 30, warranty_months: 36, warranty: "3-year labor warranty",
    highlights: ["Full prep + skim coat where needed", "2 coats premium paint", "Sherwin-Williams Emerald Interior", "Free touch-up kit included", "Priority scheduling"],
    is_enabled: false, is_default: false, sort: 5,
  },
  // Exterior — Lead Control template 2, "Exterior Painting": all three tiers on.
  {
    set_name: "Exterior Painting", name: "Good", tier: "good", scope: "exterior",
    tagline: "Solid protection and curb appeal", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams SuperPaint", coats: 1, primer_coats: 1,
    markup_pct: 0, warranty_months: 12, warranty: "1-year warranty",
    highlights: ["Power wash all surfaces", "1 coat primer + 1 coat Sherwin-Williams SuperPaint", "Caulk gaps and cracks", "Standard prep"],
    is_enabled: true, is_default: false, sort: 6,
  },
  {
    set_name: "Exterior Painting", name: "Better", tier: "better", scope: "exterior",
    tagline: "Enhanced durability for Florida weather", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams Emerald Rain Refresh", coats: 2, primer_coats: 1,
    markup_pct: 15, warranty_months: 24, warranty: "2-year warranty",
    highlights: ["Power wash + light scraping", "1 coat primer + 2 coats exterior paint", "Premium Sherwin-Williams Emerald Rain Refresh", "Caulk all trim and windows"],
    is_enabled: true, is_default: true, sort: 7,
  },
  {
    set_name: "Exterior Painting", name: "Best", tier: "best", scope: "exterior",
    tagline: "Maximum protection, premium finish", description: "",
    paint_grade: null, product_link: "Duration Exterior", product_name: "Sherwin-Williams Duration Exterior", coats: 2, primer_coats: 0,
    markup_pct: 30, warranty_months: 36, warranty: "3-year warranty",
    highlights: ["Full power wash + heavy scraping", "Epoxy primer on all bare wood", "2 coats Sherwin-Williams Duration Exterior", "Full caulking around all openings", "Free annual touch-up visit"],
    is_enabled: true, is_default: false, sort: 8,
  },
  // Exterior — Lead Control template 6, "Exterior Painting (Good)": only Better is on.
  {
    set_name: "Exterior Painting (Good)", name: "Good", tier: "good", scope: "exterior",
    tagline: "Solid protection and curb appeal", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams SuperPaint", coats: 1, primer_coats: 1,
    markup_pct: 0, warranty_months: 12, warranty: "1-year warranty",
    highlights: ["Power wash all surfaces", "1 coat primer + 1 coat Sherwin-Williams SuperPaint", "Caulk gaps and cracks", "Standard prep"],
    is_enabled: false, is_default: false, sort: 9,
  },
  {
    set_name: "Exterior Painting (Good)", name: "Better", tier: "better", scope: "exterior",
    tagline: "Enhanced durability for Florida weather", description: "",
    paint_grade: "Standard", product_link: null, product_name: "Sherwin-Williams Emerald Rain Refresh", coats: 2, primer_coats: 0,
    markup_pct: 0, warranty_months: 24, warranty: "2-year warranty",
    highlights: ["Power wash + light scraping", "2 coats exterior paint", "Premium Sherwin-Williams Emerald Rain Refresh", "Caulk all trim and windows"],
    is_enabled: true, is_default: true, sort: 10,
  },
  {
    set_name: "Exterior Painting (Good)", name: "Best", tier: "best", scope: "exterior",
    tagline: "Maximum protection, premium finish", description: "",
    paint_grade: null, product_link: "Duration Exterior", product_name: "Sherwin-Williams Duration Exterior", coats: 2, primer_coats: 0,
    markup_pct: 30, warranty_months: 36, warranty: "3-year warranty",
    highlights: ["Full power wash + heavy scraping", "Epoxy primer on all bare wood", "2 coats Sherwin-Williams Duration Exterior", "Full caulking around all openings", "Free annual touch-up visit"],
    is_enabled: false, is_default: false, sort: 11,
  },
];

/** The products a painting company starts with (core's blueprint list), when it has none yet. */
export async function seedPaintProducts(db: Db, companyId: string): Promise<number> {
  const existing = must(await db.from("paint_products").select("id").eq("company_id", companyId).limit(1));
  if (existing.length) return 0;
  const rows = DEFAULT_PAINT_PRODUCTS.map((p, i) => ({
    company_id: companyId,
    name: p.name,
    brand: p.brand,
    scope: p.scope,
    cost_per_gallon: p.costPerGallon,
    markup_pct: p.markupPct,
    coverage_per_gallon: p.coveragePerGallon,
    sort: i,
  }));
  const { error } = await db.from("paint_products").insert(rows);
  if (error) throw dbError(error);
  return rows.length;
}

/** The packages a painting company starts with (its Lead Control templates), when it has none yet. */
export async function seedPaintPackages(db: Db, companyId: string): Promise<number> {
  const existing = must(await db.from("paint_packages").select("id").eq("company_id", companyId).limit(1));
  if (existing.length) return 0;
  const products = must(await db.from("paint_products").select("id, name").eq("company_id", companyId));
  const idOf = (name: string | null) => (name ? (products.find((p) => p.name === name)?.id ?? null) : null);
  const rows = PAINT_PACKAGE_SEEDS.map(({ product_link, ...seed }) => ({ company_id: companyId, ...seed, product_id: idOf(product_link) }));
  const { error } = await db.from("paint_packages").insert(rows);
  if (error) throw dbError(error);
  return rows.length;
}

/**
 * The exterior seeds as they stood before the Nov 27, 2026 template change, kept so setup can
 * recognize a company's rows that were seeded from them and never edited since — only those
 * rows move forward to the current seeds (resyncPaintPackageSeeds below).
 */
const PREVIOUS_PAINT_PACKAGE_SEEDS: PaintPackageSeed[] = [
  {
    set_name: "Exterior Painting", name: "Good", tier: "good", scope: "exterior",
    tagline: "Solid protection and curb appeal", description: "",
    paint_grade: null, product_link: null, product_name: null, coats: 1, primer_coats: 1,
    markup_pct: 0, warranty_months: 12, warranty: "1-year warranty",
    highlights: ["Power wash all surfaces", "1 coat primer + 1 coat exterior paint", "Caulk gaps and cracks", "Standard prep"],
    is_enabled: true, is_default: false, sort: 6,
  },
  {
    set_name: "Exterior Painting", name: "Better", tier: "better", scope: "exterior",
    tagline: "Enhanced durability for Florida weather", description: "",
    paint_grade: null, product_link: null, product_name: "Sherwin-Williams Resilience", coats: 2, primer_coats: 1,
    markup_pct: 15, warranty_months: 36, warranty: "3-year warranty",
    highlights: ["Power wash + light scraping", "1 coat primer + 2 coats exterior paint", "Premium Sherwin-Williams Resilience", "Caulk all trim and windows"],
    is_enabled: true, is_default: true, sort: 7,
  },
  {
    set_name: "Exterior Painting", name: "Best", tier: "best", scope: "exterior",
    tagline: "Maximum protection, premium finish", description: "",
    paint_grade: null, product_link: "Duration Exterior", product_name: "Sherwin-Williams Duration Exterior", coats: 2, primer_coats: 0,
    markup_pct: 30, warranty_months: 60, warranty: "5-year warranty",
    highlights: ["Full power wash + heavy scraping", "Epoxy primer on all bare wood", "2 coats Sherwin-Williams Duration Exterior", "Full caulking around all openings", "Free annual touch-up visit"],
    is_enabled: true, is_default: false, sort: 8,
  },
  {
    set_name: "Exterior Painting (Good)", name: "Good", tier: "good", scope: "exterior",
    tagline: "Solid protection and curb appeal", description: "",
    paint_grade: null, product_link: null, product_name: null, coats: 1, primer_coats: 1,
    markup_pct: 0, warranty_months: 12, warranty: "1-year warranty",
    highlights: ["Power wash all surfaces", "1 coat primer + 1 coat exterior paint", "Caulk gaps and cracks", "Standard prep"],
    is_enabled: false, is_default: false, sort: 9,
  },
  {
    set_name: "Exterior Painting (Good)", name: "Better", tier: "better", scope: "exterior",
    tagline: "Enhanced durability for Florida weather", description: "",
    paint_grade: "Standard", product_link: null, product_name: "Sherwin-Williams SuperPaint", coats: 2, primer_coats: 0,
    markup_pct: 0, warranty_months: 36, warranty: "3-year warranty",
    highlights: ["Power wash + light scraping", "2 coats exterior paint", "Sherwin-Williams — SuperPaint", "Caulk all trim and windows"],
    is_enabled: true, is_default: true, sort: 10,
  },
  {
    set_name: "Exterior Painting (Good)", name: "Best", tier: "best", scope: "exterior",
    tagline: "Maximum protection, premium finish", description: "",
    paint_grade: null, product_link: "Duration Exterior", product_name: "Sherwin-Williams Duration Exterior", coats: 2, primer_coats: 0,
    markup_pct: 30, warranty_months: 60, warranty: "5-year warranty",
    highlights: ["Full power wash + heavy scraping", "Epoxy primer on all bare wood", "2 coats Sherwin-Williams Duration Exterior", "Full caulking around all openings", "Free annual touch-up visit"],
    is_enabled: false, is_default: false, sort: 11,
  },
];

/** Does this stored package row still say exactly what the given seed said when it was planted? */
function matchesSeed(row: Record<string, unknown>, seed: PaintPackageSeed, productId: string | null): boolean {
  const text = (v: unknown) => (v == null ? "" : String(v));
  const nullable = (v: unknown) => (v == null || v === "" ? null : String(v));
  return (
    text(row.set_name) === seed.set_name &&
    text(row.name) === seed.name &&
    text(row.tier) === seed.tier &&
    text(row.scope) === seed.scope &&
    text(row.tagline) === seed.tagline &&
    text(row.description) === seed.description &&
    nullable(row.paint_grade) === seed.paint_grade &&
    nullable(row.product_name) === seed.product_name &&
    (row.product_id ?? null) === productId &&
    Number(row.coats) === seed.coats &&
    Number(row.primer_coats) === seed.primer_coats &&
    Number(row.markup_pct) === seed.markup_pct &&
    Number(row.warranty_months) === seed.warranty_months &&
    text(row.warranty) === seed.warranty &&
    JSON.stringify(row.highlights ?? []) === JSON.stringify(seed.highlights) &&
    Boolean(row.is_enabled) === seed.is_enabled &&
    Boolean(row.is_default) === seed.is_default &&
    Number(row.sort) === seed.sort
  );
}

/**
 * Bring a company's exterior packages forward to the current seeds — but only the rows that
 * still match the previous seeds exactly, i.e. were planted by setup and never edited. A row
 * the office changed in any way (a different product, warranty, price, even a highlight) is
 * theirs and is left alone. Returns how many rows moved.
 */
export async function resyncPaintPackageSeeds(db: Db, companyId: string): Promise<number> {
  const rows = must(await db.from("paint_packages").select("*").eq("company_id", companyId));
  if (!rows.length) return 0;
  const products = must(await db.from("paint_products").select("id, name").eq("company_id", companyId));
  const idOf = (name: string | null) => (name ? (products.find((p) => p.name === name)?.id ?? null) : null);
  let moved = 0;
  for (const prev of PREVIOUS_PAINT_PACKAGE_SEEDS) {
    const next = PAINT_PACKAGE_SEEDS.find((s) => s.set_name === prev.set_name && s.tier === prev.tier);
    if (!next) continue;
    const row = rows.find((r) => r.set_name === prev.set_name && r.tier === prev.tier);
    if (!row || !matchesSeed(row as Record<string, unknown>, prev, idOf(prev.product_link))) continue;
    const { product_link, ...seed } = next;
    const { error } = await db.from("paint_packages").update({ ...seed, product_id: idOf(product_link) }).eq("id", row.id).eq("company_id", companyId);
    if (error) throw dbError(error);
    moved++;
  }
  return moved;
}

/** Painting's setup: the products and packages a painting company is missing (Settings → Painting, and the proposal page). */
export async function setupPainting(db: Db, companyId: string): Promise<{ products_created: number; packages_created: number; packages_resynced: number }> {
  const products_created = await seedPaintProducts(db, companyId);
  const packages_created = await seedPaintPackages(db, companyId);
  const packages_resynced = await resyncPaintPackageSeeds(db, companyId);
  return { products_created, packages_created, packages_resynced };
}

const TIER_ORDER: Record<string, number> = { good: 0, better: 1, best: 2 };
const TIER_WORD: Record<string, string> = { good: "Good", better: "Better", best: "Best" };

interface BaseLine {
  id: string;
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  material_cost: number | null;
  taxable: boolean;
  optional: boolean;
  selected: boolean;
  formula: string | null;
  sort: number;
  /** The line's room (phase 3), carried onto the copies so a package keeps the proposal's rooms. */
  paint_detail: Json | null;
}

/**
 * Offer paint packages on a proposal (POST /painting/:id/packages): each package becomes an
 * option in the Hub's pick-and-sign flow. The proposal's own priced lines become the default
 * package's option; every other package gets copies of the paint lines repriced with its
 * product and coats by the painting math, plus its markup. Optional add-on lines stay shared.
 * A proposal that already offers options is left alone (409) — take those off first.
 */
export async function applyPaintPackages(db: Db, adminDb: Db, companyId: string, quoteId: string, packageIds: readonly string[]) {
  if (!packageIds.length) throw new HttpError(400, "Pick at least one package to offer.");
  if (packageIds.length > 3) throw new HttpError(400, "A proposal offers up to 3 options.");
  const quote = must(
    await db.from("quotes").select("id, status, option_id").eq("id", quoteId).eq("company_id", companyId).maybeSingle(),
    "That proposal wasn't found.",
  );
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  const options = must(await db.from("quote_options").select("id").eq("quote_id", quoteId).eq("company_id", companyId));
  if (options.length) throw new HttpError(409, "This proposal already offers options. Take those off before offering paint packages.");

  const packages = must(await db.from("paint_packages").select("*").eq("company_id", companyId).in("id", [...packageIds]));
  if (packages.length !== packageIds.length) throw new HttpError(400, "One of those packages wasn't found.");
  const disabled = packages.find((p) => !p.is_enabled);
  if (disabled) throw new HttpError(400, `“${disabled.name}” is turned off. Turn it on in Settings → Painting first.`);
  const ordered = [...packages].sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.sort - b.sort);
  const defaultPkg = ordered.find((p) => p.is_default) ?? ordered[0]!;

  const lines = must(
    await db.from("quote_line_items").select("id, service_id, name, description, quantity, unit, unit_price, unit_cost, material_cost, taxable, optional, selected, formula, sort, paint_detail").eq("quote_id", quoteId).eq("company_id", companyId).order("sort"),
  ) as BaseLine[];
  const base = lines.filter((l) => l.selected && !l.optional);
  if (!base.length) throw new HttpError(400, "Add the work to the proposal first, then offer packages on it.");

  // The company's numbers come through the server's key (adminDb): the person's own client
  // cannot select companies.settings (20261123100100_prices_and_settings_for_the_office.sql),
  // so reading it through db answers 42501 even for the owner.
  const company = must(await adminDb.from("companies").select("settings").eq("id", companyId).maybeSingle(), "Company not found.");
  const settings = paintSettingsFrom((company.settings as Record<string, unknown> | null)?.painting);
  const services = must(await db.from("services").select("id, category, unit_cost").eq("company_id", companyId));
  const categoryOf = new Map(services.map((s) => [s.id, s.category]));
  const serviceOf = new Map(services.map((s) => [s.id, s]));
  const products = must(await db.from("paint_products").select("id, name, brand, scope, cost_per_gallon, markup_pct, coverage_per_gallon").eq("company_id", companyId));
  const productOf = new Map(products.map((p) => [p.id, p]));

  const scopeOf = (line: BaseLine): PaintScope | null => {
    const category = line.service_id ? categoryOf.get(line.service_id) : null;
    return category === "Interior" ? "interior" : category === "Exterior" ? "exterior" : null;
  };

  /** A package's lines: the base lines, paint lines repriced with the package's product and coats. */
  const linesFor = (pkg: (typeof ordered)[number]) => {
    const productRow = pkg.product_id ? productOf.get(pkg.product_id) : null;
    const product: (PaintProduct & { key: string }) | null = productRow
      ? { key: productRow.id, name: productRow.name, brand: productRow.brand, scope: productRow.scope as PaintScope, costPerGallon: Number(productRow.cost_per_gallon), markupPct: Number(productRow.markup_pct), coveragePerGallon: Number(productRow.coverage_per_gallon) }
      : null;
    const inputs: PaintSurfaceInput[] = [];
    const paintIdx: number[] = [];
    base.forEach((line, i) => {
      const scope = scopeOf(line);
      if (!scope) return;
      paintIdx.push(i);
      // The line's room, so a package's gallons round up per room like the proposal's own do.
      const room = paintDetailFrom(line.paint_detail).room ?? undefined;
      // The panel's modes, here too: hour lines are the crew's hours; per-piece lines carry
      // the price book's per-piece cost as their fee and drink no gallons of their own.
      if (line.unit === "hr") inputs.push({ room, scope, quantity: Number(line.quantity), coats: pkg.coats, laborHoursPerUnit: 1, product: null });
      else if (line.unit === "ea" || line.unit === "visit" || line.unit === "job") {
        const cost = line.service_id ? serviceOf.get(line.service_id)?.unit_cost : null;
        inputs.push({ room, scope, quantity: Number(line.quantity), coats: pkg.coats, flatFeePerUnit: cost != null ? Number(cost) : null, product: null });
      } else inputs.push({ room, scope, quantity: Number(line.quantity), coats: pkg.coats, product });
    });
    const math = paintProposalMath(inputs, settings);
    const uplift = 1 + Number(pkg.markup_pct) / 100;
    return base.map((line, i) => {
      const at = paintIdx.indexOf(i);
      if (at === -1) return { ...line };
      const m = math.surfaces[at]!;
      return { ...line, unit_price: Math.round(m.unitPrice * uplift * 100) / 100, unit_cost: Math.round((m.directCost / Math.max(Number(line.quantity), 1)) * 100) / 100, material_cost: m.materialCost };
    });
  };

  const made: Array<{ id: string; name: string; tier: string; paint_package_id: string }> = [];
  for (const [index, pkg] of ordered.entries()) {
    const option = must(
      await db
        .from("quote_options")
        .insert({
          company_id: companyId,
          quote_id: quoteId,
          paint_package_id: pkg.id,
          name: pkg.name,
          tier: TIER_WORD[pkg.tier] ?? null,
          highlights: pkg.highlights,
          warranty: pkg.warranty,
          sort: index,
        })
        .select("id")
        .single(),
    );
    made.push({ id: option.id, name: pkg.name, tier: TIER_WORD[pkg.tier] ?? pkg.tier, paint_package_id: pkg.id });
    if (pkg.id === defaultPkg.id) {
      // The proposal's own lines, as priced, are the default package's lines.
      for (const line of base) {
        const { error } = await db.from("quote_line_items").update({ option_id: option.id }).eq("id", line.id).eq("company_id", companyId);
        if (error) throw dbError(error);
      }
    } else {
      const rows = linesFor(pkg).map((line) => ({
        company_id: companyId,
        quote_id: quoteId,
        option_id: option.id,
        service_id: line.service_id,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        unit_cost: line.unit_cost,
        material_cost: line.material_cost,
        taxable: line.taxable,
        optional: false,
        selected: true,
        formula: line.formula,
        sort: line.sort,
        paint_detail: line.paint_detail,
      }));
      const { error } = await db.from("quote_line_items").insert(rows);
      if (error) throw dbError(error);
    }
  }
  const { error } = await db.from("quotes").update({ paint_package_id: defaultPkg.id, option_id: made.find((o) => o.paint_package_id === defaultPkg.id)!.id }).eq("id", quoteId).eq("company_id", companyId);
  if (error) throw dbError(error);
  return { options: made, default_package_id: defaultPkg.id };
}
