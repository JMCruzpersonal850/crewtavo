/**
 * How you compare, on Marketing → Reviews (services/reviewCompare.ts): the card's data, its switch
 * (owners and admins, checked with Google first), searching and picking places, and a check by hand.
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, param, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { addPlace, comparisonState, refreshComparison, searchPlaces, setComparison, suggestPlaces } from "../services/reviewCompare";

export const reviewCompare = new Hono<AppEnv>();

reviewCompare.get("/reviews/compare", requireUser, requireCompany(OFFICE, "marketing"), async (c) =>
  c.json({ ...(await comparisonState(c.env, adminClient(c.env), c.var.companyId)), can_switch: ADMINS.includes(c.var.role) }),
);

reviewCompare.put("/reviews/compare/enabled", requireUser, requireCompany(ADMINS, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  await setComparison(c.env, adminClient(c.env), c.var.companyId, c.var.userId, body.enabled);
  return c.json(await comparisonState(c.env, adminClient(c.env), c.var.companyId));
});

reviewCompare.get("/reviews/compare/search", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) throw new HttpError(400, "Type a business's name.");
  return c.json({ places: await searchPlaces(c.env, adminClient(c.env), c.var.companyId, q.slice(0, 120)) });
});

reviewCompare.get("/reviews/compare/suggest", requireUser, requireCompany(OFFICE, "marketing"), async (c) => c.json({ places: await suggestPlaces(c.env, adminClient(c.env), c.var.companyId) }));

reviewCompare.post("/reviews/compare/places", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ place_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,300}$/, "That isn't a Google place."), own: z.boolean().default(false) }));
  await addPlace(c.env, adminClient(c.env), c.var.companyId, body.place_id, body.own);
  return c.json(await comparisonState(c.env, adminClient(c.env), c.var.companyId));
});

reviewCompare.delete("/reviews/compare/places/:id", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  if (!uuid.safeParse(id).success) throw new HttpError(404, "Not found.");
  const { error } = await adminClient(c.env).from("review_places").delete().eq("company_id", c.var.companyId).eq("id", id);
  if (error) throw dbError(error);
  return c.json(await comparisonState(c.env, adminClient(c.env), c.var.companyId));
});

reviewCompare.post("/reviews/compare/refresh", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  await refreshComparison(c.env, adminClient(c.env), c.var.companyId, true);
  return c.json(await comparisonState(c.env, adminClient(c.env), c.var.companyId));
});
