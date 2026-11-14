/**
 * How you compare (Marketing → Reviews; supabase/migrations/20261113001420_review_comparison.sql):
 * the business's Google rating and review count next to up to five competitors', through Google
 * Places (integrations/places.ts) on the server's Google key or the company's own.
 *
 *   Its own switch   Off until an owner or admin turns it on, and only after Google answers with
 *                    the key it will use (a free ids-only search), saying what to fix when it
 *                    doesn't. Turning it on finds where "nearby" is (the company's address) and,
 *                    with Google Business Profile connected, the business's own place.
 *   Few calls        Adding a place keeps what the search already said about it, so it costs
 *                    nothing more. A check makes one Place Details call per place, with only the
 *                    fields shown: weekly by the review_compare task, by hand at most once a day.
 *                    Searches are limited per company.
 *   Stored           The card reads the last check (review_places), so it shows at once.
 */
import { MAX_COMPETITORS, nextHandCheck } from "@crewtavo/core/reviewCompare";
import { marketingOn } from "@crewtavo/core/marketing";
import type { Env } from "../env";
import { checkPlacesKey, placeDetails, placesKey, PlacesProblem, textSearch, type PlaceResult, type PlacesKey } from "../integrations/places";
import { companyAddress } from "../lib/email";
import { dbError, HttpError } from "../lib/http";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import type { Db } from "../lib/supabase";
import { geocodeAddress } from "./external";

/** Searches a company may make an hour: plenty for picking five, few enough to keep the bill small. */
const SEARCHES_PER_HOUR = 30;
/** What a search said about each place, kept a while so adding one doesn't ask Google again. */
const SEEN_MS = 60 * 60_000;
const seen = new Map<string, { at: number; place: PlaceResult }>();

const remember = (companyId: string, places: PlaceResult[]) => {
  const now = Date.now();
  for (const [k, v] of seen) if (now - v.at > SEEN_MS) seen.delete(k);
  for (const place of places) seen.set(`${companyId}:${place.place_id}`, { at: now, place });
  return places;
};

export const NO_KEY = "Add a Google key in Settings → Maps first, with Places API (New) turned on for it, or ask whoever runs your Crewtavo to set GOOGLE_MAPS_SERVER_KEY.";
export const TURNED_OFF = "Comparing with competitors is off. An owner or admin can turn it on here.";

type Company = { name: string; address: unknown; settings: unknown; trade_preset: string };

async function companyOf(admin: Db, companyId: string): Promise<Company> {
  const { data, error } = await admin.from("companies").select("name, address, settings, trade_preset").eq("id", companyId).maybeSingle();
  if (error || !data) throw new HttpError(404, "Company not found.");
  return data as Company;
}

async function comparison(admin: Db, companyId: string) {
  const { data, error } = await admin.from("review_comparisons").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw dbError(error);
  return data;
}

/** What the card shows: the switch, the key, the places as last checked, and when a check by hand can be made. */
export async function comparisonState(env: Env, admin: Db, companyId: string) {
  const [company, row, places] = await Promise.all([
    companyOf(admin, companyId),
    comparison(admin, companyId),
    admin.from("review_places").select("id, place_id, name, address, maps_url, is_own, rating, ratings_total, previous_total, checked_at, previous_checked_at").eq("company_id", companyId).order("created_at"),
  ]);
  if (places.error) throw dbError(places.error);
  const next = nextHandCheck(row?.checked_at);
  return {
    enabled: row?.enabled ?? false,
    key: placesKey(env, company.settings)?.source ?? null,
    checked_at: row?.checked_at ?? null,
    next_check: next?.toISOString() ?? null,
    last_error: row?.last_error ?? null,
    places: (places.data ?? []).map((p) => ({ ...p, rating: p.rating == null ? null : Number(p.rating) })),
  };
}

/** The key, with the switch on. */
async function readyKey(env: Env, admin: Db, companyId: string): Promise<{ key: PlacesKey; row: NonNullable<Awaited<ReturnType<typeof comparison>>>; company: Company }> {
  const [company, row] = await Promise.all([companyOf(admin, companyId), comparison(admin, companyId)]);
  if (!row?.enabled) throw new HttpError(409, TURNED_OFF);
  const key = placesKey(env, company.settings);
  if (!key) throw new HttpError(409, NO_KEY);
  return { key, row, company };
}

const asHttp = (error: unknown): never => {
  if (error instanceof PlacesProblem) throw new HttpError(502, error.message);
  throw error;
};

/**
 * The switch. On: checked with Google first (with the business's name, a free ids-only search), and
 * refused saying what to fix; then where "nearby" is, and the business's own place from Google
 * Business Profile when that's connected and it has none yet. Off: nothing is asked of Google.
 */
export async function setComparison(env: Env, admin: Db, companyId: string, userId: string, enabled: boolean) {
  if (!enabled) {
    const { error } = await admin.from("review_comparisons").upsert({ company_id: companyId, enabled: false });
    if (error) throw dbError(error);
    return;
  }
  const company = await companyOf(admin, companyId);
  if (!marketingOn(company.settings as Record<string, unknown> | null)) throw new HttpError(409, "Install Crewtavo - Marketing first.");
  const key = placesKey(env, company.settings);
  if (!key) throw new HttpError(400, NO_KEY);
  const problem = await checkPlacesKey(key, company.name);
  if (problem) throw new HttpError(400, problem);
  const address = companyAddress(company.address as Record<string, string> | null);
  const spot = address ? await geocodeAddress(address, env.GOOGLE_MAPS_SERVER_KEY).catch(() => null) : null;
  const { error } = await admin.from("review_comparisons").upsert({ company_id: companyId, enabled: true, enabled_by: userId, lat: spot?.lat ?? null, lng: spot?.lng ?? null, last_error: null });
  if (error) throw dbError(error);
  // The business itself, when Google Business Profile knows which place it is.
  const { data: own } = await admin.from("review_places").select("id").eq("company_id", companyId).eq("is_own", true).maybeSingle();
  if (!own) {
    const { data: business } = await admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle();
    const placeId = (business?.settings as { place_id?: string | null } | null)?.place_id;
    if (business && business.status !== "disconnected" && placeId) {
      const place = await placeDetails(key, placeId).catch(() => null);
      if (place) await addPlace(env, admin, companyId, place.place_id, true, place);
    }
  }
}

/** Places by name near the business. */
export async function searchPlaces(env: Env, admin: Db, companyId: string, query: string) {
  const { key, row } = await readyKey(env, admin, companyId);
  if (!(await allow(env, `places-search:${companyId}`, SEARCHES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of searches for one hour. Try again later.");
  const near = row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null;
  return remember(companyId, await textSearch(key, query, near).catch(asHttp));
}

/** The nearest businesses of the company's trade, besides the places already on the card. */
export async function suggestPlaces(env: Env, admin: Db, companyId: string) {
  const { key, row, company } = await readyKey(env, admin, companyId);
  if (!(await allow(env, `places-search:${companyId}`, SEARCHES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of searches for one hour. Try again later.");
  const near = row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null;
  if (!near) throw new HttpError(400, "Add your company's address in Settings → Company, so Crewtavo knows what's nearby. You can still search by name.");
  const trade = company.trade_preset === "general" ? "contractor" : company.trade_preset.replace(/_/g, " ");
  const { data: have } = await admin.from("review_places").select("place_id").eq("company_id", companyId);
  const taken = new Set((have ?? []).map((p) => p.place_id));
  const found = remember(companyId, await textSearch(key, trade, near, { nearestFirst: true }).catch(asHttp));
  return found.filter((p) => !taken.has(p.place_id) && p.name.trim().toLowerCase() !== company.name.trim().toLowerCase());
}

/**
 * Adds a place to the card: what a search just said about it, or one Place Details call when it
 * wasn't searched for here. `own`: the business itself (one at most).
 */
export async function addPlace(env: Env, admin: Db, companyId: string, placeId: string, own: boolean, known?: PlaceResult) {
  const { key } = await readyKey(env, admin, companyId);
  const cached = known ?? seen.get(`${companyId}:${placeId}`)?.place;
  const place = cached ?? (await placeDetails(key, placeId).catch(asHttp));
  if (!own) {
    const { count } = await admin.from("review_places").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("is_own", false);
    if ((count ?? 0) >= MAX_COMPETITORS) throw new HttpError(400, "Compare with up to five competitors. Remove one first.");
  } else {
    await admin.from("review_places").update({ is_own: false }).eq("company_id", companyId).eq("is_own", true);
  }
  const { data, error } = await admin
    .from("review_places")
    .upsert({ company_id: companyId, place_id: place.place_id, name: place.name.slice(0, 300), address: place.address?.slice(0, 500) ?? null, maps_url: place.maps_url, is_own: own }, { onConflict: "company_id,place_id" })
    .select("id")
    .single();
  if (error) throw error.code === "22023" ? new HttpError(400, error.message) : dbError(error);
  if (place.rating != null || place.ratings_total != null) {
    await admin.rpc("record_review_place", { p_id: data.id, p_name: place.name, p_rating: place.rating ?? 0, p_total: place.ratings_total ?? 0, p_maps_url: place.maps_url ?? undefined });
  }
  return data.id as string;
}

/**
 * A check: one Place Details call for each place, with only the fields shown; the count before is
 * kept, to say how it changed. `byHand`: at most once a day (the weekly check counts).
 */
export async function refreshComparison(env: Env, admin: Db, companyId: string, byHand: boolean) {
  const { key, row } = await readyKey(env, admin, companyId);
  if (byHand && nextHandCheck(row.checked_at)) throw new HttpError(429, "Checked in the last day. You can check again tomorrow.");
  const { data: places, error } = await admin.from("review_places").select("id, place_id").eq("company_id", companyId);
  if (error) throw dbError(error);
  let problem: string | null = null;
  let checked = 0;
  for (const place of places ?? []) {
    try {
      const found = await placeDetails(key, place.place_id);
      await admin.rpc("record_review_place", { p_id: place.id, p_name: found.name, p_rating: found.rating ?? 0, p_total: found.ratings_total ?? 0, p_maps_url: found.maps_url ?? undefined });
      checked++;
    } catch (failure) {
      if (!(failure instanceof PlacesProblem)) throw failure;
      problem = failure.message;
      // The key itself is refused: the rest would be too.
      if (!checked) break;
    }
  }
  // The next check waits its turn even when this one failed, so a refused key isn't asked again
  // every hour; each place keeps the date it was last read (review_places.checked_at).
  const now = new Date().toISOString();
  await admin.from("review_comparisons").update({ checked_at: now, ...(byHand ? { checked_by_hand_at: now } : {}), last_error: problem }).eq("company_id", companyId);
  if (problem && !checked && byHand) throw new HttpError(502, problem);
  return { checked, problem };
}

/** The review_compare task: each company whose weekly check is due. */
export async function refreshDueComparisons(env: Env, admin: Db) {
  const { data: due, error } = await admin.rpc("review_comparisons_due", { p_limit: 20 });
  if (error) throw new Error(error.message);
  let checked = 0;
  let failed = 0;
  for (const { company_id } of due ?? []) {
    try {
      const result = await refreshComparison(env, admin, company_id, false);
      checked += result.checked;
      if (result.problem) failed++;
    } catch (error) {
      failed++;
      if (!(error instanceof HttpError)) reportError(error, { feature: "review_compare" });
      // No key anymore, say: kept for the card to say, and not tried again until next week.
      else await admin.from("review_comparisons").update({ checked_at: new Date().toISOString(), last_error: error.message }).eq("company_id", company_id);
    }
  }
  return { companies: due?.length ?? 0, checked, failed };
}
