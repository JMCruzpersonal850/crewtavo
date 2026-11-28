/**
 * Live tracking on the way (services/tracking.ts): the crew phone's pings land only from someone
 * on the visit, only while it's en route, only while the company shares, and never after the
 * worker stopped sharing for the trip; the public page's data is the visit's own state with the
 * last place's age said plainly; and the link the on-my-way run carries is a signed "track"
 * link, good for four hours, that the team copy never keeps. The database is the in-memory one;
 * what the rows themselves allow is in supabase/tests.
 */
import { describe, expect, it } from "vitest";
import { readClientLink } from "../src/lib/links";
import type { Db } from "../src/lib/supabase";
import type { Env } from "../src/env";
import { withTrackingLine, withTrackingLink, type RunContext } from "../src/services/automations";
import { recordPing, stopSharing, trackingLink, trackView } from "../src/services/tracking";
import { memoryClient, memoryDb, type MemoryDb } from "./fixtures/memoryDb";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
} as Env;

const CO = "co-1";
const VISIT = "visit-1";
const RAY = "user-ray";
const SAM = "user-sam";
const NOW = new Date("2026-11-27T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

const world = (over: Partial<Record<string, Array<Record<string, any>>>> = {}): MemoryDb =>
  memoryDb(
    {
      companies: [{ id: CO, name: "Ocean Crest Painting", phone: "850-555-0100", settings: {} }],
      visits: [
        {
          id: VISIT,
          company_id: CO,
          title: "Exterior repaint",
          status: "en_route",
          crew_id: null,
          eta_at: minutesAhead(25),
          property: { line1: "504 Silverthorn Road", line2: null, city: "Gulf Breeze", region: "FL", postal_code: "32561", lat: 30.357, lng: -87.164 },
        },
      ],
      visit_live_location: [],
      visit_assignees: [{ company_id: CO, visit_id: VISIT, user_id: RAY }],
      crew_members: [],
      profiles: [{ user_id: RAY, full_name: "Ray Diaz" }],
      ...over,
    },
    { visit_live_location: ["visit_id"] },
  );

const asDb = (db: MemoryDb) => memoryClient(db) as unknown as Db;

const fails = async (p: Promise<unknown>): Promise<{ status?: number; message: string }> => {
  try {
    await p;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("expected it to fail, and it didn't");
};

describe("a crew phone's pings", () => {
  it("keeps only the latest place, from someone on the visit while it's en route", async () => {
    const db = world();
    await recordPing(asDb(db), CO, VISIT, RAY, { lat: 30.35, lng: -87.17, accuracy: 12 }, NOW);
    await recordPing(asDb(db), CO, VISIT, RAY, { lat: 30.355, lng: -87.166 }, new Date(NOW.getTime() + 12_000));
    expect(db.tables.visit_live_location).toHaveLength(1);
    expect(db.tables.visit_live_location![0]).toMatchObject({ visit_id: VISIT, user_id: RAY, lat: 30.355, lng: -87.166, sharing_stopped_at: null });
  });

  it("refuses someone who isn't on the visit, and a visit that isn't on its way", async () => {
    const db = world();
    expect(await fails(recordPing(asDb(db), CO, VISIT, SAM, { lat: 1, lng: 2 }, NOW))).toMatchObject({ status: 403 });
    const done = world({ visits: [{ id: VISIT, company_id: CO, title: "Exterior repaint", status: "in_progress", crew_id: null, eta_at: null, property: null }] });
    expect(await fails(recordPing(asDb(done), CO, VISIT, RAY, { lat: 1, lng: 2 }, NOW))).toMatchObject({ status: 409 });
    expect(await fails(recordPing(asDb(db), CO, "no-such-visit", RAY, { lat: 1, lng: 2 }, NOW))).toMatchObject({ status: 404 });
  });

  it("lets a crew member share, not only the named assignee", async () => {
    const db = world({
      visits: [{ id: VISIT, company_id: CO, title: "Exterior repaint", status: "en_route", crew_id: "crew-1", eta_at: minutesAhead(25), property: null }],
      visit_assignees: [],
      crew_members: [{ company_id: CO, crew_id: "crew-1", user_id: SAM }],
    });
    await recordPing(asDb(db), CO, VISIT, SAM, { lat: 30.35, lng: -87.17 }, NOW);
    expect(db.tables.visit_live_location).toHaveLength(1);
  });

  it("is off altogether while the company doesn't share live tracking", async () => {
    const db = world({ companies: [{ id: CO, name: "Ocean Crest Painting", phone: null, settings: { tracking: { live: false } } }] });
    expect(await fails(recordPing(asDb(db), CO, VISIT, RAY, { lat: 1, lng: 2 }, NOW))).toMatchObject({ status: 403 });
  });

  it("stops at the worker's Stop sharing, and starts clean on the next trip out", async () => {
    const db = world();
    await recordPing(asDb(db), CO, VISIT, RAY, { lat: 30.35, lng: -87.17 }, NOW);
    await stopSharing(asDb(db), CO, VISIT, RAY, new Date(NOW.getTime() + 60_000));
    expect(await fails(recordPing(asDb(db), CO, VISIT, RAY, { lat: 30.36, lng: -87.16 }, new Date(NOW.getTime() + 120_000)))).toMatchObject({ status: 409 });
    // Sent out again: services/schedule.ts deletes the trip's row as the visit goes en route,
    // so the new trip starts clean and sharing begins again with its first ping.
    db.tables.visit_live_location = [];
    await recordPing(asDb(db), CO, VISIT, RAY, { lat: 30.36, lng: -87.16 }, new Date(NOW.getTime() + 180_000));
    expect(db.tables.visit_live_location![0]).toMatchObject({ lat: 30.36, sharing_stopped_at: null });
  });

  it("won't stop sharing for someone who isn't on the visit", async () => {
    const db = world();
    expect(await fails(stopSharing(asDb(db), CO, VISIT, SAM, NOW))).toMatchObject({ status: 403 });
  });
});

describe("the public page's data", () => {
  it("shows the last place with its age, the drive from there, and the crew member's first name", async () => {
    const db = world({ visit_live_location: [{ visit_id: VISIT, company_id: CO, user_id: RAY, lat: 30.352, lng: -87.168, recorded_at: minutesAgo(5), sharing_stopped_at: null }] });
    const view = await trackView(asDb(db), CO, VISIT, NOW);
    expect(view.state).toBe("en_route");
    expect(view.ping).toMatchObject({ lat: 30.352, lng: -87.168, age_seconds: 300 });
    expect(view.eta_minutes).toBeGreaterThanOrEqual(1);
    expect(view.crew).toEqual({ first_name: "Ray" });
    expect(view.visit.address).toContain("504 Silverthorn Road");
    expect(view.visit.destination).toEqual({ lat: 30.357, lng: -87.164 });
    expect(view.company.name).toBe("Ocean Crest Painting");
  });

  it("is waiting, with the promised arrival, before the first report", async () => {
    const view = await trackView(asDb(world()), CO, VISIT, NOW);
    expect(view.state).toBe("waiting");
    expect(view.ping).toBeNull();
    expect(view.eta_minutes).toBe(25);
  });

  it("says the sharing stopped, and shows no place, after the worker stopped it", async () => {
    const db = world({ visit_live_location: [{ visit_id: VISIT, company_id: CO, user_id: RAY, lat: 30.352, lng: -87.168, recorded_at: minutesAgo(2), sharing_stopped_at: minutesAgo(1) }] });
    const view = await trackView(asDb(db), CO, VISIT, NOW);
    expect(view.state).toBe("stopped");
    expect(view.ping).toBeNull();
  });

  it("a stop from an earlier trip is gone with its row when the visit is sent out again", async () => {
    // services/schedule.ts deletes the trip's row as the visit goes en route again; with the
    // row gone, the page is back to waiting for this trip's first report.
    const db = world({ visit_live_location: [] });
    expect((await trackView(asDb(db), CO, VISIT, NOW)).state).toBe("waiting");
  });

  it("is arrived once the visit starts, and ended when it's cancelled — never a stale place", async () => {
    const live = [{ visit_id: VISIT, company_id: CO, user_id: RAY, lat: 30.352, lng: -87.168, recorded_at: minutesAgo(1), sharing_stopped_at: null }];
    const visit = (status: string) => [{ id: VISIT, company_id: CO, title: "Exterior repaint", status, crew_id: null, eta_at: null, property: { line1: "504 Silverthorn Road", line2: null, city: "Gulf Breeze", region: "FL", postal_code: "32561", lat: 30.357, lng: -87.164 } }];
    const arrived = await trackView(asDb(world({ visits: visit("in_progress"), visit_live_location: live })), CO, VISIT, NOW);
    expect(arrived.state).toBe("arrived");
    expect(arrived.ping).toBeNull();
    const ended = await trackView(asDb(world({ visits: visit("cancelled"), visit_live_location: live })), CO, VISIT, NOW);
    expect(ended.state).toBe("ended");
    expect(ended.ping).toBeNull();
  });

  it("is a 404 for a visit that isn't there", async () => {
    expect(await fails(trackView(asDb(world()), CO, "no-such-visit", NOW))).toMatchObject({ status: 404 });
  });
});

describe("the link in the on-my-way text", () => {
  const ctx = (settings: Record<string, unknown> = {}): RunContext =>
    ({
      subject: "visit",
      id: VISIT,
      label: "Exterior repaint",
      company: { id: CO, settings },
      client: null,
      facts: {},
      vars: {},
      appPath: "",
      jobId: null,
      propertyId: null,
    }) as unknown as RunContext;

  it("is a signed track link for the visit, good for four hours", async () => {
    const url = await trackingLink(env, "https://ops.example.com", CO, VISIT);
    expect(url.startsWith("https://ops.example.com/track/")).toBe(true);
    const payload = await readClientLink(env, url.split("/track/")[1]!);
    expect(payload).toMatchObject({ c: CO, t: "track", id: VISIT });
    const life = payload!.exp - payload!.at! / 1000;
    expect(life).toBeGreaterThan(4 * 3600 - 120);
    expect(life).toBeLessThanOrEqual(4 * 3600);
  });

  it("rides only on a visit setting out, and only while the company shares", async () => {
    const on = await withTrackingLink(env, ctx(), "visit.en_route", "https://ops.example.com");
    expect(on.vars.tracking_link).toContain("/track/");
    const off = await withTrackingLink(env, ctx({ tracking: { live: false } }), "visit.en_route", "https://ops.example.com");
    expect(off.vars.tracking_link).toBeUndefined();
    const other = await withTrackingLink(env, ctx(), "visit.reminder", "https://ops.example.com");
    expect(other.vars.tracking_link).toBeUndefined();
  });

  it("is added to the sent words when the template left it out, and not twice", async () => {
    const run = await withTrackingLink(env, ctx(), "visit.en_route", "https://ops.example.com");
    const body = "Hi Ana, our crew is on the way now.";
    const withLine = withTrackingLine(body, { ...run, trigger: "visit.en_route" } as RunContext);
    expect(withLine).toBe(`${body}\nTrack them live: ${run.vars.tracking_link}`);
    expect(withTrackingLine(withLine, { ...run, trigger: "visit.en_route" } as RunContext)).toBe(withLine);
    expect(withTrackingLine(body, { ...run, trigger: "visit.reminder" } as RunContext)).toBe(body);
  });
});
