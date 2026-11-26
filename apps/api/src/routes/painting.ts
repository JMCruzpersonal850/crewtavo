/**
 * Painting: the painting trade's own back-fill. Painting belongs to painting businesses only —
 * the gate is the company's trade preset (core painting.ts), never an installable app — so these
 * routes refuse any company whose trade isn't painting before doing anything. What a painting
 * company gets at signup comes from applyPreset like every trade; this is for a company that
 * switches its trade to painting later (Settings → Company) and needs the pack its price list
 * and fields are missing.
 */
import { ADMINS, isPaintingTrade } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, must } from "../lib/http";
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
