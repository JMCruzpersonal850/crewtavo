/**
 * How you compare (services/reviewCompare.ts, integrations/places.ts): Google Places is asked with
 * the server's key or the company's own (as its web address), for only the fields shown; a check
 * makes one Place Details call per place and keeps the count before; a check by hand waits a day;
 * the switch turns on only once Google answers. Google and the database answer what each test gives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkPlacesKey, placeDetails, placesKey, textSearch } from "../src/integrations/places";
import { refreshComparison, setComparison } from "../src/services/reviewCompare";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db }));

const env: Env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://crew.example.com" };
const CO = "00000000-0000-4000-8000-0000000000c0";
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: string; headers: Record<string, string>; body: any };

function google(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return reply(call);
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe("the key", () => {
  it("is the server's when it has one, else the company's own, sent as from the company's address", () => {
    expect(placesKey({ ...env, GOOGLE_MAPS_SERVER_KEY: "server-key" }, { maps: { google_key: "own" } })).toEqual({ key: "server-key", referer: null, source: "server" });
    expect(placesKey(env, { maps: { google_key: " own-key " } })).toEqual({ key: "own-key", referer: "https://crew.example.com/", source: "company" });
    expect(placesKey(env, {})).toBeNull();
  });

  it("is checked with a free ids-only search, and Google's refusal says what to fix", async () => {
    const ok = google(() => answer(200, { places: [{ id: "p1" }] }));
    expect(await checkPlacesKey({ key: "k", referer: "https://crew.example.com/", source: "company" }, "Sketchy Gutters", ok.fetcher)).toBeNull();
    expect(ok.calls[0]!.headers["X-Goog-FieldMask"]).toBe("places.id");
    expect(ok.calls[0]!.headers.Referer).toBe("https://crew.example.com/");
    const off = google(() => answer(403, { error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 1 before or it is disabled." } }));
    expect(await checkPlacesKey({ key: "k", referer: null, source: "server" }, "x", off.fetcher)).toMatch(/enable Places API \(New\)/);
  });
});

describe("asking Google", () => {
  const key = { key: "k", referer: null, source: "server" as const };
  it("searches near the business for the fields the card shows, nearest first only when asked", async () => {
    const g = google(() => answer(200, { places: [{ id: "p1", displayName: { text: "Rival Gutters" }, formattedAddress: "1 Elm St", rating: 4.4, userRatingCount: 51, googleMapsUri: "https://maps.google.com/?cid=1" }, { id: "p2" }] }));
    const found = await textSearch(key, "gutters", { lat: 39.78, lng: -89.65 }, { nearestFirst: true }, g.fetcher);
    expect(found).toEqual([{ place_id: "p1", name: "Rival Gutters", address: "1 Elm St", rating: 4.4, ratings_total: 51, maps_url: "https://maps.google.com/?cid=1" }]);
    expect(g.calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(g.calls[0]!.headers["X-Goog-FieldMask"]).toBe("places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri");
    expect(g.calls[0]!.body).toMatchObject({ textQuery: "gutters", rankPreference: "DISTANCE", locationBias: { circle: { center: { latitude: 39.78, longitude: -89.65 } } } });
    await textSearch(key, "Rival", null, {}, g.fetcher);
    expect(g.calls[1]!.body).not.toHaveProperty("rankPreference");
    expect(g.calls[1]!.body).not.toHaveProperty("locationBias");
  });

  it("reads a place with only its name, rating, review count and Maps link", async () => {
    const g = google(() => answer(200, { id: "p1", displayName: { text: "Rival" }, rating: 4.1, userRatingCount: 9 }));
    expect(await placeDetails(key, "p1", g.fetcher)).toMatchObject({ place_id: "p1", rating: 4.1, ratings_total: 9 });
    expect(g.calls[0]!.url).toBe("https://places.googleapis.com/v1/places/p1");
    expect(g.calls[0]!.headers["X-Goog-FieldMask"]).toBe("id,displayName,rating,userRatingCount,googleMapsUri");
    await expect(placeDetails(key, "../admin", g.fetcher)).rejects.toThrow(/isn't a Google place/);
    expect(g.calls).toHaveLength(1);
  });
});

type Row = Record<string, any>;
function memoryDb(tables: Record<string, Row[]>) {
  const recorded: Row[] = [];
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let change: Row | null = null;
    let upsert: Row | null = null;
    let single = false;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (upsert) {
        const found = rows.find((r) => r.company_id === upsert!.company_id);
        if (found) Object.assign(found, upsert);
        else rows.push({ ...upsert });
        return { data: null, error: null };
      }
      const matching = rows.filter((r) => filters.every((f) => f(r)));
      if (change) {
        for (const r of matching) Object.assign(r, change);
        return { data: null, error: null };
      }
      return { data: single ? (matching[0] ?? null) : matching.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: () => q,
      update: (v: Row) => ((change = v), q),
      upsert: (v: Row) => ((upsert = v), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      match: (v: Row) => (filters.push((r) => Object.entries(v).every(([k, x]) => r[k] === x)), q),
      order: () => q,
      maybeSingle: () => ((single = true), q),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  };
  return {
    recorded,
    from: query,
    rpc: async (name: string, args: Row) => {
      if (name === "record_review_place") recorded.push(args);
      return { data: name === "rate_limit_hit" ? true : null, error: null };
    },
  };
}

describe("a check", () => {
  const world = (checkedAt: string | null) => ({
    companies: [{ id: CO, name: "Sketchy Gutters", address: {}, trade_preset: "general", settings: { marketing: { enabled: true }, maps: { google_key: "own-key" } } }],
    review_comparisons: [{ company_id: CO, enabled: true, checked_at: checkedAt, lat: null, lng: null }],
    review_places: [{ id: "a", company_id: CO, place_id: "pa" }, { id: "b", company_id: CO, place_id: "pb" }, { id: "c", company_id: CO, place_id: "pc" }],
  });

  it("makes one Place Details call per place and records each", async () => {
    const tables = world(null);
    const db = memoryDb(tables);
    current.db = db;
    const g = google((call) => answer(200, { id: call.url.split("/").pop(), displayName: { text: "X" }, rating: 4.5, userRatingCount: 10 }));
    vi.stubGlobal("fetch", g.fetcher);
    await refreshComparison(env, db as never, CO, true);
    expect(g.calls.map((c) => c.url.split("/").pop())).toEqual(["pa", "pb", "pc"]);
    expect(db.recorded.map((r) => r.p_id)).toEqual(["a", "b", "c"]);
    expect(tables.review_comparisons[0]!.checked_at).toBeTruthy();
  });

  it("by hand, at most once a day", async () => {
    const db = memoryDb(world(new Date(Date.now() - 3_600_000).toISOString()));
    current.db = db;
    const g = google(() => answer(200, {}));
    vi.stubGlobal("fetch", g.fetcher);
    await expect(refreshComparison(env, db as never, CO, true)).rejects.toThrow(/check again tomorrow/);
    expect(g.calls).toHaveLength(0);
  });

  it("turns on only once Google answers the key, and says what to fix when it doesn't", async () => {
    const tables = world(null);
    tables.review_comparisons = [];
    const db = memoryDb(tables);
    current.db = db;
    vi.stubGlobal("fetch", google(() => answer(400, { error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } })).fetcher);
    await expect(setComparison(env, db as never, CO, "u1", true)).rejects.toThrow(/didn't accept the key/);
    expect(tables.review_comparisons).toHaveLength(0);
    tables.companies[0]!.settings = { marketing: { enabled: true } };
    await expect(setComparison(env, db as never, CO, "u1", true)).rejects.toThrow(/Add a Google key in Settings → Maps/);
  });
});
