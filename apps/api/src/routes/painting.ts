/**
 * Painting: the painting trade's own routes. Painting belongs to painting businesses only —
 * the gate is the company's trade preset (core painting.ts), never an installable app — so
 * every route here refuses any company whose trade isn't painting before doing anything.
 * What a painting company gets at signup comes from applyPreset like every trade; the
 * back-fill below is for a company that switches its trade to painting later (Settings →
 * Company). Phase 2 adds the company's painting numbers (settings.painting), its products
 * and its Good / Better / Best packages, and offering those packages on a proposal.
 */
import { ADMINS, OFFICE, SALES } from "@crewtavo/core";
import { isPaintingTrade, paintSettingsFrom, type PaintSettings } from "@crewtavo/core/painting";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { applyPaintPackages, setupPainting } from "../services/paintPackages";
import { addMissingCustomFields, addMissingServices } from "../services/presetServices";

export const painting = new Hono<AppEnv>();

/** Refuse a company that isn't a painting business: painting's surfaces are not for other trades. */
async function requirePainting(c: Context<AppEnv>) {
  const company = must(await c.var.db.from("companies").select("trade_preset").eq("id", c.var.companyId).maybeSingle(), "Company not found.");
  if (!isPaintingTrade(company.trade_preset)) {
    throw new HttpError(403, "Painting is only for a painting business. Switch the trade in Settings → Company first.");
  }
}

/** The painting services and fields (color, sheen, product, lead-safe) this company is missing, added from the painting preset. */
painting.post("/painting/services", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const services = await addMissingServices(c.var.db, c.var.companyId, "painting");
  const fields = await addMissingCustomFields(c.var.db, c.var.companyId, "painting");
  return c.json({ added: services, fields });
});

/** Painting's setup: the products and packages (its Lead Control templates) it is missing. */
painting.post("/painting/setup", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  await requirePainting(c);
  return c.json(await setupPainting(c.var.db, c.var.companyId));
});

/* ------------------------------------------------------------------------------------------
 * The company's painting numbers (companies.settings.painting)
 * ---------------------------------------------------------------------------------------- */

const paintSettingsSchema = z.object({
  subInteriorRate: z.number().min(0).max(1000),
  subExteriorRate: z.number().min(0).max(1000),
  laborRate: z.number().min(0).max(10000),
  materialMarkupPct: z.number().min(0).max(1000),
  defaultMarginPct: z.number().min(0).max(99),
  overheadPct: z.number().min(0).max(100),
  warrantyReservePct: z.number().min(0).max(100),
});

/** The company's painting numbers, over the defaults (Settings → Painting, and the proposal page's math). */
painting.get("/painting/settings", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  await requirePainting(c);
  const company = must(await c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(), "Company not found.");
  return c.json({ settings: paintSettingsFrom((company.settings as Record<string, unknown> | null)?.painting) });
});

/** Save the company's painting numbers; the rest of its settings are left as they are. */
painting.put("/painting/settings", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, z.object({ settings: paintSettingsSchema }));
  const company = must(await c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(), "Company not found.");
  const current = (company.settings ?? {}) as Record<string, unknown>;
  const saved: PaintSettings = { ...body.settings };
  const { error } = await c.var.db.from("companies").update({ settings: asJson({ ...current, painting: saved }) }).eq("id", c.var.companyId);
  if (error) throw dbError(error);
  return c.json({ settings: saved });
});

/* ------------------------------------------------------------------------------------------
 * Products (paint_products)
 * ---------------------------------------------------------------------------------------- */

const productSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brand: z.string().trim().max(80).nullable().optional(),
  scope: z.enum(["interior", "exterior", "trim"]),
  cost_per_gallon: z.number().min(0).max(100000),
  markup_pct: z.number().min(0).max(1000),
  coverage_per_gallon: z.number().positive().max(100000),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});

const productRow = (p: Record<string, unknown>) => ({
  id: p.id,
  name: p.name,
  brand: p.brand ?? null,
  scope: p.scope,
  cost_per_gallon: Number(p.cost_per_gallon),
  markup_pct: Number(p.markup_pct),
  coverage_per_gallon: Number(p.coverage_per_gallon),
  active: p.active !== false,
  sort: Number(p.sort ?? 0),
});

/** The company's paints (Settings → Painting, and the proposal page's math). */
painting.get("/painting/products", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  await requirePainting(c);
  const rows = must(await c.var.db.from("paint_products").select("*").eq("company_id", c.var.companyId).order("sort"));
  return c.json({ products: rows.map(productRow) });
});

painting.post("/painting/products", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, productSchema);
  const row = must(await c.var.db.from("paint_products").insert({ company_id: c.var.companyId, ...body, brand: body.brand ?? null }).select("*").single(), "That product couldn't be saved.");
  return c.json({ product: productRow(row) }, 201);
});

painting.put("/painting/products/:id", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, productSchema);
  const row = must(
    await c.var.db.from("paint_products").update({ ...body, brand: body.brand ?? null }).eq("id", param(c, "id")).eq("company_id", c.var.companyId).select("*").maybeSingle(),
    "That product wasn't found.",
  );
  return c.json({ product: productRow(row) });
});

painting.delete("/painting/products/:id", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const { error } = await c.var.db.from("paint_products").delete().eq("id", param(c, "id")).eq("company_id", c.var.companyId);
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------------------------------
 * Packages (paint_packages)
 * ---------------------------------------------------------------------------------------- */

const packageSchema = z.object({
  set_name: z.string().trim().max(80).optional(),
  name: z.string().trim().min(1).max(80),
  tier: z.enum(["good", "better", "best"]),
  scope: z.enum(["interior", "exterior"]),
  tagline: z.string().trim().max(200).optional(),
  description: z.string().trim().max(600).optional(),
  paint_grade: z.string().trim().max(40).nullable().optional(),
  product_id: uuid.nullable().optional(),
  product_name: z.string().trim().max(120).nullable().optional(),
  coats: z.number().int().min(1).max(5).optional(),
  primer_coats: z.number().int().min(0).max(3).optional(),
  markup_pct: z.number().min(0).max(1000).optional(),
  warranty_months: z.number().int().min(0).max(240).optional(),
  warranty: z.string().trim().max(400).optional(),
  highlights: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  is_enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});

const packageRow = (p: Record<string, unknown>) => ({
  id: p.id,
  set_name: p.set_name ?? "",
  name: p.name,
  tier: p.tier,
  scope: p.scope,
  tagline: p.tagline ?? "",
  description: p.description ?? "",
  paint_grade: p.paint_grade ?? null,
  product_id: p.product_id ?? null,
  product_name: p.product_name ?? null,
  coats: Number(p.coats ?? 2),
  primer_coats: Number(p.primer_coats ?? 0),
  markup_pct: Number(p.markup_pct ?? 0),
  warranty_months: Number(p.warranty_months ?? 0),
  warranty: p.warranty ?? "",
  highlights: (p.highlights as string[]) ?? [],
  is_enabled: p.is_enabled !== false,
  is_default: p.is_default === true,
  sort: Number(p.sort ?? 0),
});

/** The company's Good / Better / Best packages (Settings → Painting, and the proposal page). */
painting.get("/painting/packages", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  await requirePainting(c);
  const rows = must(await c.var.db.from("paint_packages").select("*").eq("company_id", c.var.companyId).order("sort"));
  return c.json({ packages: rows.map(packageRow) });
});

painting.post("/painting/packages", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, packageSchema);
  const row = must(await c.var.db.from("paint_packages").insert({ company_id: c.var.companyId, ...body }).select("*").single(), "That package couldn't be saved.");
  return c.json({ package: packageRow(row) }, 201);
});

painting.put("/painting/packages/:id", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, packageSchema.partial());
  const row = must(
    await c.var.db.from("paint_packages").update({ ...body }).eq("id", param(c, "id")).eq("company_id", c.var.companyId).select("*").maybeSingle(),
    "That package wasn't found.",
  );
  return c.json({ package: packageRow(row) });
});

painting.delete("/painting/packages/:id", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  await requirePainting(c);
  const { error } = await c.var.db.from("paint_packages").delete().eq("id", param(c, "id")).eq("company_id", c.var.companyId);
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/**
 * Offer packages on a proposal: each becomes an option the client picks and signs in the Hub.
 * The proposal's lines become the default package's option; the others are repriced copies.
 */
painting.post("/painting/:id/packages", requireUser, requireCompany(SALES, "sales"), async (c) => {
  await requirePainting(c);
  const body = await readJson(c, z.object({ package_ids: z.array(uuid).min(1).max(3) }));
  return c.json(await applyPaintPackages(c.var.db, c.var.companyId, param(c, "id"), body.package_ids));
});
