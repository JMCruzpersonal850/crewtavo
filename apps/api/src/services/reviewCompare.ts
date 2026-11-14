/**
 * GOOGLE'S TERMS, AND WHAT IS KEPT HERE. Everything this keeps about a place is Google Maps
 * Content, and Google's Places API policies say what may be kept and for how long
 * (developers.google.com/maps/documentation/places/web-service/policies, "Pre-fetching, caching, or
 * storage of content"; read 2026-11-14). Each stored field falls under one of three rules:
 *
 *   review_places.place_id                     A place ID: exempt from the caching restrictions,
 *                                              may be kept indefinitely. Fine as it is.
 *   review_comparisons.lat, lng, located_at    Coordinates: may be cached "for up to 30 consecutive
 *                                              calendar days", then must be deleted. They are:
 *                                              expire_review_locations forgets them after 30 days
 *                                              (20261113001590_review_comparison_location.sql), and
 *                                              they're found again when someone next searches.
 *   review_places.name, address, maps_url,     Everything else: "Cache or store Google Maps Content
 *     rating, ratings_total, previous_total,   only as expressly permitted", and the page names
 *     checked_at, previous_checked_at          copying and saving "business names, addresses, or
 *                                              user reviews" as not allowed. These ARE kept, for
 *                                              good, so the card shows at once and can say how a
 *                                              count changed since last week. Whether to go on
 *                                              keeping them is the owner's decision and hasn't been
 *                                              made. To stop: keep place_id and is_own only, read
 *                                              each place from Google when the card is opened
 *                                              (comparisonState), and drop record_review_place and
 *                                              the week-on-week change, which needs last week's count.
 *
 * The card also shows Google's attribution and its notice about reviews, as the same page asks
 * (apps/web/src/features/marketing/ReviewCompare.tsx).
 *
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
import { checkPlacesKey, PLACE_CLOSED, PLACE_GONE, placeDetails, placesKey, PlacesProblem, textSearch, type PlaceResult, type PlacesKey } from "../integrations/places";
import { companyAddress } from "../lib/email";
import { dbError, HttpError } from "../lib/http";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import type { Db } from "../lib/supabase";
import { geocodeAddress } from "./external";

/** Searches a company may make an hour: plenty for picking five, few enough to keep the bill small. */
const SEARCHES_PER_HOUR = 30;
/** Places a company may add an hour that Google has to be asked about: plenty for picking five. */
const ADDS_PER_HOUR = 20;
/** Checks by hand a company may try an hour, while one hasn't worked yet. Each asks Google about every place. */
const HAND_TRIES_PER_HOUR = 6;
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
    admin.from("review_places").select("id, place_id, name, address, maps_url, is_own, rating, ratings_total, previous_total, checked_at, previous_checked_at, problem").eq("company_id", companyId).order("created_at"),
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
  const { error } = await admin.from("review_comparisons").upsert({ company_id: companyId, enabled: true, enabled_by: userId, ...(await locate(env, company)), last_error: null });
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

/** How long where "nearby" is may be kept: Google's limit for coordinates (see the top of this file). */
export const LOCATION_DAYS = 30;

/** The company's address as a point on the map, with when it was found; nulls when it can't be found. */
async function locate(env: Env, company: Company): Promise<{ lat: number | null; lng: number | null; located_at: string | null }> {
  const address = companyAddress(company.address as Record<string, string> | null);
  const spot = address ? await geocodeAddress(address, env.GOOGLE_MAPS_SERVER_KEY).catch(() => null) : null;
  return spot ? { lat: spot.lat, lng: spot.lng, located_at: new Date().toISOString() } : { lat: null, lng: null, located_at: null };
}

/**
 * Where "nearby" is, for a search: the point kept, while it's under 30 days old; otherwise it's
 * found again from the company's address and kept for another 30. A point older than that is never
 * used, whether or not the hourly task has forgotten it yet.
 */
export async function nearby(env: Env, admin: Db, companyId: string, row: { lat: number | null; lng: number | null; located_at?: string | null }, company: Company): Promise<{ lat: number; lng: number } | null> {
  const fresh = row.located_at != null && Date.now() - Date.parse(row.located_at) < LOCATION_DAYS * 86_400_000;
  if (fresh && row.lat != null && row.lng != null) return { lat: row.lat, lng: row.lng };
  const spot = await locate(env, company);
  await admin.from("review_comparisons").update(spot).eq("company_id", companyId);
  return spot.lat != null && spot.lng != null ? { lat: spot.lat, lng: spot.lng } : null;
}

/** Places by name near the business. */
export async function searchPlaces(env: Env, admin: Db, companyId: string, query: string) {
  const { key, row, company } = await readyKey(env, admin, companyId);
  if (!(await allow(env, `places-search:${companyId}`, SEARCHES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of searches for one hour. Try again later.");
  const near = await nearby(env, admin, companyId, row, company);
  return remember(companyId, await textSearch(key, query, near).catch(asHttp));
}

/** The nearest businesses of the company's trade, besides the places already on the card. */
export async function suggestPlaces(env: Env, admin: Db, companyId: string) {
  const { key, row, company } = await readyKey(env, admin, companyId);
  if (!(await allow(env, `places-search:${companyId}`, SEARCHES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of searches for one hour. Try again later.");
  const near = await nearby(env, admin, companyId, row, company);
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
  // The cap and the pace are checked before Google is asked anything: a sixth competitor, or a
  // loop of adds, costs the key's account nothing.
  if (!own) {
    const { data: have } = await admin.from("review_places").select("place_id, is_own").eq("company_id", companyId);
    const competitors = (have ?? []).filter((p) => !p.is_own && p.place_id !== placeId).length;
    if (competitors >= MAX_COMPETITORS) throw new HttpError(400, "Compare with up to five competitors. Remove one first.");
  }
  const cached = known ?? seen.get(`${companyId}:${placeId}`)?.place;
  if (!cached && !(await allow(env, `places-add:${companyId}`, ADDS_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of places for one hour. Try again later.");
  const place = cached ?? (await placeDetails(key, placeId).catch(asHttp));
  if (own) await admin.from("review_places").update({ is_own: false }).eq("company_id", companyId).eq("is_own", true);
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

/** "Acme Paving", "Acme Paving and Best Roofing", "Acme Paving, Best Roofing and Top Lawn". */
const named = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What a check skipped, in a sentence that names each place and says what to do. */
export function skippedWords(gone: readonly string[], closed: readonly string[]): string | null {
  const parts = [
    gone.length ? `Google doesn't list ${named(gone)} anymore` : "",
    closed.length ? `${gone.length ? "and says " : "Google says "}${named(closed)} ${closed.length === 1 ? "is" : "are"} permanently closed` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  const n = gone.length + closed.length;
  return `${parts.join(", ")}, so ${n === 1 ? "it was" : "they were"} skipped. Remove ${n === 1 ? "it" : "them"} from the list to compare with someone else.`;
}

/**
 * A check: one Place Details call for each place, with only the fields shown; the count from a week
 * back is kept, to say how it changed (record_review_place). `byHand`: at most once a day after a
 * check that worked (the weekly one counts), and a few tries an hour when one didn't.
 *
 * One place Google no longer lists, or marks permanently closed, is named and skipped, and the rest
 * are still read. Trouble with the key itself stops the check where it is: the next place would
 * get the same answer. `checked_at` moves only when at least one place was read, so a check that
 * failed outright can be tried again as soon as what's wrong is fixed.
 */
export async function refreshComparison(env: Env, admin: Db, companyId: string, byHand: boolean) {
  const { key, row } = await readyKey(env, admin, companyId);
  if (byHand && nextHandCheck(row.checked_at)) throw new HttpError(429, "Checked in the last day. You can check again tomorrow.");
  if (byHand && !(await allow(env, `compare-check:${companyId}`, HAND_TRIES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of checks for one hour. Try again later.");
  const { data: places, error } = await admin.from("review_places").select("id, place_id, name").eq("company_id", companyId).order("created_at");
  if (error) throw dbError(error);
  let keyProblem: string | null = null;
  let checked = 0;
  const gone: string[] = [];
  const closed: string[] = [];
  for (const place of places ?? []) {
    try {
      const found = await placeDetails(key, place.place_id);
      if (found.closed) {
        closed.push(found.name);
        await admin.from("review_places").update({ problem: PLACE_CLOSED }).eq("id", place.id);
        continue;
      }
      await admin.rpc("record_review_place", { p_id: place.id, p_name: found.name, p_rating: found.rating ?? 0, p_total: found.ratings_total ?? 0, p_maps_url: found.maps_url ?? undefined });
      checked++;
    } catch (failure) {
      if (!(failure instanceof PlacesProblem)) throw failure;
      if (failure.place) {
        gone.push(place.name ?? "a place");
        await admin.from("review_places").update({ problem: PLACE_GONE }).eq("id", place.id);
        continue;
      }
      // The key, its project or Google itself: the rest would get the same answer.
      keyProblem = failure.message;
      break;
    }
  }
  const problem = keyProblem ?? skippedWords(gone, closed);
  const now = new Date().toISOString();
  await admin.from("review_comparisons").update({ ...(checked ? { checked_at: now, ...(byHand ? { checked_by_hand_at: now } : {}) } : {}), last_error: problem }).eq("company_id", companyId);
  if (keyProblem && !checked && byHand) throw new HttpError(502, keyProblem);
  return { checked, problem };
}

/**
 * The review_compare task: each company whose weekly check is due, claimed as it's taken
 * (claim_review_comparisons), so two servers running the task in the same minute don't both ask
 * Google. A company whose check fails is claimed again the next day.
 */
export async function refreshDueComparisons(env: Env, admin: Db) {
  // Where "nearby" is, forgotten 30 days after it was found (Google's limit for coordinates).
  const { error: kept } = await admin.rpc("expire_review_locations");
  if (kept) reportError(new Error(`Couldn't forget old review comparison locations: ${kept.message}`), { feature: "review_compare" });
  const { data: due, error } = await admin.rpc("claim_review_comparisons", { p_limit: 20 });
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
      // No key anymore, say: kept for the card to say. When it last worked is left alone, so it's tried again tomorrow.
      else await admin.from("review_comparisons").update({ last_error: error.message }).eq("company_id", company_id);
    }
  }
  return { companies: due?.length ?? 0, checked, failed };
}
