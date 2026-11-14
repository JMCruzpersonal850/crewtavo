/**
 * Google Places API (New), from the server, for How you compare (services/reviewCompare.ts): Text
 * Search to find a business by name near the company (or the nearest of its trade), and Place
 * Details for a place's rating and review count. Each call asks only for the fields it shows
 * (X-Goog-FieldMask), which also keeps it in Google's cheapest tier that has them.
 *
 * The key: the server's GOOGLE_MAPS_SERVER_KEY when whoever runs Crewtavo set one; else the company's
 * own Google key from Settings → Maps. That one is a browser key, usually limited to the company's
 * web address, so requests made with it say they come from that address (Referer: APP_URL), as the
 * company's own pages would. Either way Places API (New) has to be turned on for the key's project.
 */
import type { MapSettings } from "@crewtavo/core/imagery";
import type { Env } from "../env";

const PLACES = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 10_000;
type FetchLike = typeof fetch;

export interface PlacesKey {
  key: string;
  /** The address a browser key is limited to, sent as the Referer. */
  referer: string | null;
  source: "server" | "company";
}

/** The key Places calls use for a company, or null when there's none. */
export function placesKey(env: Env, settings: unknown): PlacesKey | null {
  if (env.GOOGLE_MAPS_SERVER_KEY) return { key: env.GOOGLE_MAPS_SERVER_KEY, referer: null, source: "server" };
  const own = ((settings as { maps?: MapSettings } | null)?.maps?.google_key ?? "").trim();
  return own ? { key: own, referer: env.APP_URL ? `${env.APP_URL.replace(/\/$/, "")}/` : null, source: "company" } : null;
}

/** What Google said, in words that say what to fix. */
export class PlacesProblem extends Error {}

type GoogleError = { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } };

export function placesProblem(status: number, error?: GoogleError["error"]): string {
  const text = `${error?.status ?? ""} ${error?.message ?? ""} ${(error?.details ?? []).map((d) => d.reason ?? "").join(" ")}`;
  if (/API_KEY_INVALID|not valid/i.test(text)) return "Google didn't accept the key. Check the Google key in Settings → Maps.";
  if (/referer|referrer/i.test(text)) return "The Google key is limited to other websites. In Google Cloud, add this Crewtavo's address to the key's website restrictions.";
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return "The Google key's project doesn't have Places API (New) turned on. In Google Cloud, enable Places API (New) for it.";
  if (/API_KEY_SERVICE_BLOCKED|are blocked/i.test(text)) return "The Google key isn't allowed to use Places API (New). In Google Cloud, add Places API (New) to the key's API restrictions.";
  if (/billing/i.test(text)) return "Google needs a billing account on the key's project before it answers Places requests.";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return "The Google key has used up its Places quota for now. Try again later.";
  if (status === 403) return "Google refused the key for Places. Check that Places API (New) is allowed for it.";
  return "Google Places isn't answering right now. Try again later.";
}

async function ask<T>(key: PlacesKey, path: string, fields: string, init: { method?: string; body?: unknown } = {}, fetcher: FetchLike = fetch): Promise<T> {
  const res = await fetcher(`${PLACES}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "X-Goog-Api-Key": key.key,
      "X-Goog-FieldMask": fields,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(key.referer ? { Referer: key.referer } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new PlacesProblem("Couldn't reach Google. Try again in a minute.");
  const body = (await res.json().catch(() => ({}))) as T & GoogleError;
  if (!res.ok || body.error) throw new PlacesProblem(placesProblem(res.status, body.error));
  return body;
}

export interface PlaceResult {
  place_id: string;
  name: string;
  address: string | null;
  rating: number | null;
  ratings_total: number | null;
  maps_url: string | null;
}

type GooglePlace = { id?: string; displayName?: { text?: string }; formattedAddress?: string; rating?: number; userRatingCount?: number; googleMapsUri?: string };

const toResult = (p: GooglePlace): PlaceResult | null =>
  p.id && p.displayName?.text
    ? {
        place_id: p.id,
        name: p.displayName.text,
        address: p.formattedAddress ?? null,
        rating: typeof p.rating === "number" ? p.rating : null,
        ratings_total: typeof p.userRatingCount === "number" ? p.userRatingCount : 0,
        maps_url: p.googleMapsUri?.startsWith("https://") ? p.googleMapsUri : null,
      }
    : null;

const SEARCH_FIELDS = "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri";
const DETAIL_FIELDS = "id,displayName,rating,userRatingCount,googleMapsUri";
/** Within about 30 miles. */
const NEAR_METERS = 50_000;

/**
 * Places matching `query`, leaning toward `near` (a business by its name, or "landscaping" for the
 * nearest of a trade with `nearestFirst`). Text Search (New) takes the page size as `pageSize` (once
 * `maxResultCount`) and sorts by distance only with a location to measure from: both are here, and
 * only here, should Google change them.
 */
export async function textSearch(key: PlacesKey, query: string, near: { lat: number; lng: number } | null, options: { nearestFirst?: boolean; pageSize?: number } = {}, fetcher: FetchLike = fetch): Promise<PlaceResult[]> {
  const body = await ask<{ places?: GooglePlace[] }>(key, "/places:searchText", SEARCH_FIELDS, {
    method: "POST",
    body: {
      textQuery: query.slice(0, 200),
      pageSize: options.pageSize ?? 10,
      languageCode: "en",
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: NEAR_METERS } } } : {}),
      ...(near && options.nearestFirst ? { rankPreference: "DISTANCE" } : {}),
    },
  }, fetcher);
  return (body.places ?? []).map(toResult).filter((p): p is PlaceResult => p !== null);
}

/** One place's name, rating, review count and Maps link: one Place Details call, with only those fields. */
export async function placeDetails(key: PlacesKey, placeId: string, fetcher: FetchLike = fetch): Promise<PlaceResult> {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(placeId)) throw new PlacesProblem("That isn't a Google place.");
  const place = toResult(await ask<GooglePlace>(key, `/places/${placeId}`, DETAIL_FIELDS, {}, fetcher));
  if (!place) throw new PlacesProblem("Google didn't say what that place is.");
  return place;
}

/**
 * Whether a key answers Places at all: a Text Search asking for place ids only, which Google
 * doesn't charge for. A sentence saying what to fix, or null when it works.
 */
export async function checkPlacesKey(key: PlacesKey, query: string, fetcher: FetchLike = fetch): Promise<string | null> {
  try {
    await ask(key, "/places:searchText", "places.id", { method: "POST", body: { textQuery: query.slice(0, 200) || "hardware store", pageSize: 1 } }, fetcher);
    return null;
  } catch (error) {
    if (error instanceof PlacesProblem) return error.message;
    throw error;
  }
}
