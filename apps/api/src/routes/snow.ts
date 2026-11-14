/**
 * Snow (Apps → Crewtavo - Snow): Install and Uninstall; what the forecast calls for at each snow
 * customer, with the official winter alerts where they are; one customer's weather in detail; and
 * scheduling a storm. The snow customers themselves, the season's storms and which subs can go out are read and
 * saved from the page itself (snow_sites, snow_events, snow_availability); the snow task tells the
 * crews the day before (snowWatch in tasks.ts). Forecasts come from the business's own source
 * (services/forecast.ts).
 */
import { ADMINS, addDays, DISPATCH, localDate, snowPlan } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { placeKey } from "../services/external";
import { forecasterFor, placeWeather, placeWeathers, winterAlerts } from "../services/forecast";

export const snow = new Hono<AppEnv>();

/** Snow on its Apps page: Install and Uninstall (public.trade_app_set_enabled). */
snow.post("/snow/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { error } = await c.var.db.rpc("trade_app_set_enabled", { p_company: c.var.companyId, p_app: "snow", p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

/** The business's tomorrow and its forecast source: what every snow forecast here goes by. */
async function snowDay(c: Context<AppEnv>) {
  const company = must(await c.var.db.from("companies").select("timezone, weather_source:settings->weather_source").eq("id", c.var.companyId).maybeSingle());
  return { tomorrow: addDays(localDate(new Date(), company.timezone), 1), forecaster: await forecasterFor(c.env, adminClient(c.env), c.var.companyId, company) };
}

/** The business's snow customers (active jobs) with where they are, as the caller may see them. */
async function snowSites(c: Context<AppEnv>, only?: string[]) {
  let query = c.var.db.from("snow_sites").select("job_id, trigger_in, salt_trigger_in, repeat_in, job:jobs!inner(status, paused_at, property:properties(lat, lng))").eq("company_id", c.var.companyId).eq("job.status", "active").limit(1000);
  if (only) query = query.in("job_id", only);
  return must(await query).map((s) => ({
    job_id: s.job_id,
    paused: Boolean(s.job.paused_at),
    rules: { trigger_in: Number(s.trigger_in), salt_trigger_in: s.salt_trigger_in == null ? null : Number(s.salt_trigger_in), repeat_in: s.repeat_in == null ? null : Number(s.repeat_in) },
    place: s.job.property?.lat != null && s.job.property.lng != null ? { lat: s.job.property.lat, lng: s.job.property.lng } : null,
  }));
}

/**
 * The snow forecast at each active snow customer, in inches from 6pm today through tomorrow as the
 * snow task counts it, by job id: null where there's no map location or no forecast. `date` is
 * tomorrow, `source` whose forecast it is, and `alerts` the official winter alerts in force where
 * the customers are (the National Weather Service's, whatever the source).
 */
snow.get("/snow/forecast", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const [{ tomorrow, forecaster }, sites] = await Promise.all([snowDay(c), snowSites(c)]);
  const places = sites.flatMap((s) => (s.place ? [s.place] : []));
  const [weather, alerts] = await Promise.all([placeWeathers(places, forecaster, 3), winterAlerts(places).catch(() => [])]);
  const inches: Record<string, number | null> = {};
  for (const s of sites) inches[s.job_id] = s.place ? weather.get(placeKey(s.place.lat, s.place.lng))?.snow_by_day[tomorrow] ?? null : null;
  return c.json({ date: tomorrow, source: forecaster.source, inches, alerts });
});

/**
 * The weather in detail at one job's property, for the Snow page's weather view: now, hour by hour
 * and day by day (PlaceWeather), with the snow coming by tomorrow as the alerts count it. Asked by
 * job, not by coordinates, so it's only ever a place the person may see.
 */
snow.get("/snow/weather", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const jobId = uuid.safeParse(c.req.query("job"));
  if (!jobId.success) throw new HttpError(400, "Pick a job to see its weather.");
  const [{ tomorrow, forecaster }, job] = await Promise.all([
    snowDay(c),
    c.var.db.from("jobs").select("id, property:properties(lat, lng)").eq("company_id", c.var.companyId).eq("id", jobId.data).maybeSingle(),
  ]);
  const place = must(job, "That job wasn't found.").property;
  if (place?.lat == null || place.lng == null) throw new HttpError(400, "This job's property has no map location yet, so there's no forecast for it. Fix the address on the property.");
  const weather = await placeWeather(place.lat, place.lng, forecaster).catch(() => null);
  // 424, not 502: the app reads a 502 as Crewtavo itself restarting, and says so on every screen.
  if (!weather) throw new HttpError(424, "The forecast couldn't be loaded right now. Try again in a minute.");
  return c.json({ ...weather, tomorrow, snow_by_tomorrow_in: weather.snow_by_day[tomorrow] ?? null });
});

/**
 * Schedule them, on the Snow page: tomorrow's visits for these snow customers, as many as the
 * forecast calls for now (worked out here, not taken from the page), with their people on them
 * (public.snow_schedule, which checks who's asking and never doubles a visit). A customer the
 * forecast no longer calls for anything at is left alone.
 */
snow.post("/snow/schedule", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const body = await readJson(c, z.object({ job_ids: z.array(uuid).min(1).max(1000) }));
  const [{ tomorrow, forecaster }, sites] = await Promise.all([snowDay(c), snowSites(c, body.job_ids)]);
  const weather = await placeWeathers(sites.flatMap((s) => (s.place && !s.paused ? [s.place] : [])), forecaster, 3);
  const plan = sites.flatMap((s) => {
    const inches = s.place && !s.paused ? weather.get(placeKey(s.place.lat, s.place.lng))?.snow_by_day[tomorrow] : null;
    const called = snowPlan(s.rules, inches);
    return called && inches != null ? [{ job_id: s.job_id, inches, pushes: called.pushes, kind: called.kind }] : [];
  });
  if (!plan.length) return c.json({ created: 0, date: tomorrow });
  const { data, error } = await c.var.db.rpc("snow_schedule", { p_company: c.var.companyId, p_date: tomorrow, p_plan: plan });
  if (error) throw dbError(error);
  return c.json({ created: data ?? 0, date: tomorrow });
});
