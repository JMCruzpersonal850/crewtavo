/**
 * How you compare (services/reviewCompare.ts, integrations/places.ts): Google Places is asked with
 * the server's key or the company's own (as its web address), for only the fields shown; a check
 * makes one Place Details call per place and keeps the count before; a check by hand waits a day;
 * the switch turns on only once Google answers. Google and the database answer what each test gives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkPlacesKey, placeDetails, placesKey, textSearch } from "../src/integrations/places";
import { addPlace, refreshComparison, refreshDueComparisons, setComparison, skippedWords } from "../src/services/reviewCompare";

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
    expect(g.calls[0]!.headers["X-Goog-FieldMask"]).toBe("id,displayName,rating,userRatingCount,googleMapsUri,businessStatus");
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
  const calls: string[] = [];
  const db = {
    recorded,
    calls,
    /** The limiter says no. */
    limited: false,
    from: query,
    rpc: async (name: string, args: Row) => {
      calls.push(name);
      if (name === "record_review_place") recorded.push(args);
      // Every company with the comparison on is due, and claimed.
      if (name === "claim_review_comparisons") return { data: (tables.review_comparisons ?? []).filter((r) => r.enabled).map((r) => ({ company_id: r.company_id })), error: null };
      return { data: name === "rate_limit_hit" ? !db.limited : null, error: null };
    },
  };
  return db;
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

  it("names a place Google no longer lists, or says is closed, skips it and still reads the rest", async () => {
    const tables = world(null);
    Object.assign(tables.review_places[0]!, { name: "Gone Gutters" });
    Object.assign(tables.review_places[1]!, { name: "Shut Gutters" });
    const db = memoryDb(tables);
    current.db = db;
    const g = google((call) => {
      const id = call.url.split("/").pop();
      if (id === "pa") return answer(404, { error: { status: "NOT_FOUND", message: "Place not found." } });
      if (id === "pb") return answer(200, { id, displayName: { text: "Shut Gutters" }, rating: 4.1, userRatingCount: 30, businessStatus: "CLOSED_PERMANENTLY" });
      return answer(200, { id, displayName: { text: "Open Gutters" }, rating: 4.5, userRatingCount: 10, businessStatus: "OPERATIONAL" });
    });
    vi.stubGlobal("fetch", g.fetcher);
    const result = await refreshComparison(env, db as never, CO, true);
    // The first place being gone doesn't stop the others being asked about.
    expect(g.calls.map((c) => c.url.split("/").pop())).toEqual(["pa", "pb", "pc"]);
    expect(db.recorded.map((r) => r.p_id)).toEqual(["c"]);
    expect(result).toEqual({ checked: 1, problem: "Google doesn't list Gone Gutters anymore, and says Shut Gutters is permanently closed, so they were skipped. Remove them from the list to compare with someone else." });
    expect(tables.review_comparisons[0]).toMatchObject({ last_error: result.problem });
    expect(tables.review_comparisons[0]!.checked_at).toBeTruthy();
    expect(tables.review_places.map((p: Row) => p.problem ?? null)).toEqual(["Google doesn't list this place anymore.", "Google says this place is permanently closed.", null]);
    expect(skippedWords(["Gone Gutters"], [])).toBe("Google doesn't list Gone Gutters anymore, so it was skipped. Remove it from the list to compare with someone else.");
    expect(skippedWords([], [])).toBeNull();
  });

  it("stops at once when it's the key Google refuses, and a check that failed doesn't make the next one wait a day", async () => {
    const tables = world(null);
    const db = memoryDb(tables);
    current.db = db;
    const refused = google(() => answer(403, { error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 1 before or it is disabled." } }));
    vi.stubGlobal("fetch", refused.fetcher);
    await expect(refreshComparison(env, db as never, CO, true)).rejects.toThrow(/enable Places API \(New\)/);
    // One call, not one per place: the others would be refused the same way.
    expect(refused.calls).toHaveLength(1);
    expect(tables.review_comparisons[0]).toMatchObject({ checked_at: null });
    expect(tables.review_comparisons[0]!.last_error).toMatch(/enable Places API/);
    // The key's project is fixed: "Check now" works straight away.
    const fixed = google((call) => answer(200, { id: call.url.split("/").pop(), displayName: { text: "X" }, rating: 4.5, userRatingCount: 10 }));
    vi.stubGlobal("fetch", fixed.fetcher);
    await expect(refreshComparison(env, db as never, CO, true)).resolves.toMatchObject({ checked: 3, problem: null });
    expect(tables.review_comparisons[0]!.checked_at).toBeTruthy();
    expect(tables.review_comparisons[0]!.last_error).toBeNull();
  });

  it("takes each company's weekly check by claiming it, and leaves a failed one to be tried tomorrow", async () => {
    const tables = world(new Date(Date.now() - 8 * 86_400_000).toISOString());
    const db = memoryDb(tables);
    current.db = db;
    const lastWorked = tables.review_comparisons[0]!.checked_at;
    vi.stubGlobal("fetch", google(() => answer(503, {})).fetcher);
    await expect(refreshDueComparisons(env, db as never)).resolves.toEqual({ companies: 1, checked: 0, failed: 1 });
    expect(db.calls).toContain("claim_review_comparisons");
    expect(db.calls).not.toContain("review_comparisons_due");
    // When it last worked hasn't moved, so the card's "Check now" isn't locked out either.
    expect(tables.review_comparisons[0]).toMatchObject({ checked_at: lastWorked });
    expect(tables.review_comparisons[0]!.last_error).toMatch(/isn't answering/);
  });
});

describe("adding a place", () => {
  const world = () => ({
    companies: [{ id: CO, name: "Sketchy Gutters", address: {}, trade_preset: "general", settings: { marketing: { enabled: true }, maps: { google_key: "own-key" } } }],
    review_comparisons: [{ company_id: CO, enabled: true, checked_at: null, lat: null, lng: null }],
    review_places: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, company_id: CO, place_id: `p${i}`, is_own: false })) as Row[],
  });

  it("turns down a sixth competitor before Google is asked anything", async () => {
    const db = memoryDb(world());
    current.db = db;
    const g = google(() => answer(200, { id: "p9", displayName: { text: "Sixth" }, rating: 4, userRatingCount: 1 }));
    vi.stubGlobal("fetch", g.fetcher);
    await expect(addPlace(env, db as never, CO, "p9", false)).rejects.toThrow(/up to five competitors/);
    expect(g.calls).toHaveLength(0);
  });

  it("is limited to so many an hour, so a loop of adds can't run up the key's bill", async () => {
    const tables = world();
    tables.review_places = [];
    const db = memoryDb(tables);
    db.limited = true;
    current.db = db;
    const g = google(() => answer(200, { id: "p9", displayName: { text: "One" }, rating: 4, userRatingCount: 1 }));
    vi.stubGlobal("fetch", g.fetcher);
    await expect(addPlace(env, db as never, CO, "p9", false)).rejects.toThrow(/a lot of places for one hour/);
    expect(g.calls).toHaveLength(0);
  });
});

describe("the switch", () => {
  const world = (checkedAt: string | null) => ({
    companies: [{ id: CO, name: "Sketchy Gutters", address: {}, trade_preset: "general", settings: { marketing: { enabled: true }, maps: { google_key: "own-key" } } }],
    review_comparisons: [{ company_id: CO, enabled: true, checked_at: checkedAt, lat: null, lng: null }],
    review_places: [{ id: "a", company_id: CO, place_id: "pa" }, { id: "b", company_id: CO, place_id: "pb" }, { id: "c", company_id: CO, place_id: "pc" }],
  });

  it("turns on only once Google answers the key, and says what to fix when it doesn't", async () => {
    const tables = world(null);
    tables.review_comparisons = [];
    const db = memoryDb(tables);
    current.db = db;
    vi.stubGlobal("fetch", google(() => answer(400, { error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } })).fetcher);
    await expect(setComparison(env, db as never, CO, "u1", true)).rejects.toThrow(/didn't accept the key/);
    expect(tables.review_comparisons).toHaveLength(0);
    (tables.companies[0] as { settings: unknown }).settings = { marketing: { enabled: true } };
    await expect(setComparison(env, db as never, CO, "u1", true)).rejects.toThrow(/Add a Google key in Settings → Maps/);
  });
});
