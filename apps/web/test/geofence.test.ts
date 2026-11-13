/**
 * The clock at the property on the phone (features/field/geofence.ts; the decisions are core's,
 * packages/core/test/geofence.test.ts): which visits it watches, what it kept between looks and
 * across a reload, which taps take a visit's clock off it, what it asks and while that still means
 * anything, and how Timesheets tells its clocks from taps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ api: {}, supabase: () => ({}), unwrap: (r: { data: unknown }) => r.data }));
const { actionWords, geofenceKey, geofenceSites, loadGeofence, promptStands, promptText, saveGeofence, tappedVisits } = await import("../src/features/field/geofence");
const { atPropertyNote } = await import("../src/features/timesheets/clockPlace");
const { emptyGeofence } = await import("@crewtavo/core/geofence");
type MyDayVisit = import("../src/features/field/myDay").MyDayVisit;
type GeofencePrompt = import("../src/features/field/geofence").GeofencePrompt;

const store = new Map<string, string>();
const storage = {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

const visit = (id: string, over: Partial<MyDayVisit> = {}): MyDayVisit => ({
  id, title: `Visit ${id}`, kind: "job", status: "scheduled", starts_at: null, ends_at: null, scheduled_on: "2026-11-13", route_order: null, hold_reason: null, crew_id: null,
  job: { id: `job-${id}`, number: 1, title: "Mowing", client: null }, property: { id: `p-${id}`, line1: "12 Oak St", city: "Springfield", lat: 40, lng: -75 },
  assignees: [], series_day: null, series_total: null, mine: true, ...over,
});

describe("the visits it watches", () => {
  it("is today's visits this person is on, at a property with a point on the map, not finished", () => {
    const sites = geofenceSites([
      visit("a"),
      visit("b", { status: "in_progress", property: { id: "p", line1: "", city: null, lat: 41, lng: -74 } }),
      visit("c", { mine: false }),
      visit("d", { property: { id: "p", line1: "1 Elm", city: null, lat: null, lng: null } }),
      visit("e", { property: null, address: "A task somewhere" }),
      visit("f", { status: "completed" }),
      visit("g", { status: "cancelled" }),
      // A copy kept on the phone from before "mine" was added: it was on My day, so it's theirs.
      visit("h", { mine: undefined }),
    ]);
    expect(sites).toEqual([
      { visitId: "a", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" },
      { visitId: "b", lat: 41, lng: -74, place: "Visit b", status: "in_progress" },
      { visitId: "h", lat: 40, lng: -75, place: "12 Oak St", status: "scheduled" },
    ]);
    expect(geofenceSites(undefined)).toEqual([]);
  });
});

describe("what it kept between looks", () => {
  const key = geofenceKey("c1", "ray", "2026-11-13");

  it("comes back as it was saved, per company, person and day", () => {
    const state = { last: 5, sites: { a: { where: "inside" as const, inRow: 2, firstIn: 1, outSince: null, tapped: true } } };
    saveGeofence(key, state);
    expect(loadGeofence(key)).toEqual(state);
    expect(loadGeofence(geofenceKey("c1", "sam", "2026-11-13"))).toEqual(emptyGeofence());
  });

  it("drops other days' as it saves today's, and leaves other people's alone", () => {
    store.set(geofenceKey("c1", "ray", "2026-11-12"), "{}");
    store.set(geofenceKey("c1", "sam", "2026-11-12"), "{}");
    store.set("something-else", "1");
    saveGeofence(key, emptyGeofence());
    expect([...store.keys()].sort()).toEqual([geofenceKey("c1", "ray", "2026-11-13"), geofenceKey("c1", "sam", "2026-11-12"), "something-else"].sort());
  });

  it("starts again from nothing when what's there can't be read, or storage is off", () => {
    store.set(key, "not json");
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    store.set(key, JSON.stringify({ last: 1 }));
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } });
    expect(loadGeofence(key)).toEqual(emptyGeofence());
    expect(() => saveGeofence(key, emptyGeofence())).not.toThrow();
  });
});

describe("which taps take a visit's clock off it", () => {
  const change = (over: object = {}) => ({ companyId: "c1", userId: "ray", who: ["ray"], target: { category: "visit" as const, visit: { id: "v2", jobId: null, title: "Elm" } }, at: "2026-11-13T15:00:00Z", ...over });

  it("is the visit a tap of their own puts their clock on, and the one it takes it off", () => {
    expect(tappedVisits(change(), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual(["v2", "v1"]);
    expect(tappedVisits(change({ target: null }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual(["v1"]);
    expect(tappedVisits(change({ target: { category: "break" } }), "ray", null)).toEqual([]);
    expect(tappedVisits(change({ target: null, fromVisit: "v1" }), "ray", null)).toEqual(["v1"]);
  });

  it("isn't the phone's own, nor a crew lead's tap that leaves them out", () => {
    expect(tappedVisits(change({ geofence: true }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual([]);
    expect(tappedVisits(change({ who: ["sam"] }), "ray", { visit: { id: "v1", title: "Oak" } })).toEqual([]);
    // A lead clocking the whole crew in, themselves included, is their own tap too.
    expect(tappedVisits(change({ userId: "lou", who: ["lou", "ray"] }), "ray", null)).toEqual(["v2"]);
  });
});

describe("what it says and asks", () => {
  const prompt = (over: Partial<GeofencePrompt>): GeofencePrompt => ({ id: "x", kind: "start", visitId: "v1", jobId: null, title: "Mowing", place: "12 Oak St", ...over });

  it("asks in one line", () => {
    expect(promptText(prompt({}))).toEqual({ title: "You're at 12 Oak St", question: "Start the visit?" });
    expect(promptText(prompt({ clockOnly: true }))).toEqual({ title: "You're at 12 Oak St", question: "Start your clock?" });
    expect(promptText(prompt({ kind: "finish", complete: true, stopClock: true }))).toEqual({ title: "Leaving 12 Oak St", question: "Complete the visit, or stop your clock?" });
    expect(promptText(prompt({ kind: "finish", complete: true })).question).toBe("Complete the visit?");
    expect(promptText(prompt({ kind: "finish", stopClock: true })).question).toBe("Stop your clock?");
  });

  it("says what the phone did by itself", () => {
    expect(actionWords({ kind: "start-clock", visitId: "v1", at: 0 }, "12 Oak St")).toBe("Clock started at 12 Oak St");
    expect(actionWords({ kind: "stop-clock", visitId: "v1", at: 0, travel: false }, "12 Oak St")).toBe("Clock stopped as you left 12 Oak St");
    expect(actionWords({ kind: "stop-clock", visitId: "v1", at: 0, travel: true }, "12 Oak St")).toBe("You left 12 Oak St, so your clock is on driving");
    expect(actionWords({ kind: "ask-start", visitId: "v1", clockOnly: false }, "12 Oak St")).toBeNull();
  });

  it("stops asking once the question is answered some other way", () => {
    const on = { visit: { id: "v1", title: "Mowing" } };
    expect(promptStands(prompt({}), "scheduled", null)).toBe(true);
    expect(promptStands(prompt({}), "en_route", null)).toBe(true);
    expect(promptStands(prompt({}), "in_progress", on)).toBe(false);
    expect(promptStands(prompt({ clockOnly: true }), "in_progress", null)).toBe(true);
    expect(promptStands(prompt({ clockOnly: true }), "in_progress", on)).toBe(false);
    const finish = prompt({ kind: "finish", complete: true, stopClock: true });
    expect(promptStands(finish, "in_progress", null)).toBe(true);
    expect(promptStands(prompt({ kind: "finish", stopClock: true }), "scheduled", null)).toBe(false);
    expect(promptStands(prompt({ kind: "finish", stopClock: true }), "scheduled", on)).toBe(true);
    for (const status of ["completed", "cancelled", undefined]) expect(promptStands(finish, status, on)).toBe(false);
  });
});

describe("on Timesheets", () => {
  it("tells the phone's clocks from taps", () => {
    expect(atPropertyNote({ category: "visit", geofence_in: false, geofence_out: false })).toBeNull();
    expect(atPropertyNote({ category: "visit" })).toBeNull();
    expect(atPropertyNote({ category: "visit", geofence_in: true, geofence_out: true })).toBe("Started and stopped by the phone at the property");
    expect(atPropertyNote({ category: "visit", geofence_in: true })).toBe("Started by the phone on arriving at the property");
    expect(atPropertyNote({ category: "visit", geofence_out: true })).toBe("Stopped by the phone on leaving the property");
    expect(atPropertyNote({ category: "drive", geofence_in: true })).toBe("Started by the phone on leaving a property");
    expect(atPropertyNote({ category: "drive", geofence_out: true })).toBe("Stopped by the phone on arriving at a property");
    expect(atPropertyNote({ category: "drive", geofence_in: true, geofence_out: true })).toBe("Started by the phone on leaving a property, stopped on arriving at a property");
  });
});
