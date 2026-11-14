/**
 * Background tasks against a stand-in for PostgREST and the forecast: fetch is stubbed, and each
 * test answers the requests it expects. (What the database functions do is tested in supabase/tests.)
 */
import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cronMatches } from "../src/lib/cron";
import { CRON_TASKS, runTask, TASKS } from "../src/tasks";

// Autopay's own work is tested in autopay.test.ts and the Stripe tests; here, only that the tasks call it.
const autopay = vi.hoisted(() => ({ reconcile: vi.fn(async () => 0), bank: vi.fn(async () => 0), charge: vi.fn(), job: vi.fn() }));
vi.mock("../src/integrations/stripe", async (original) => ({
  ...(await original<typeof import("../src/integrations/stripe")>()),
  reconcileAutopayProcessing: autopay.reconcile,
  reconcileBankPayments: autopay.bank,
}));
vi.mock("../src/services/autopay", async (original) => ({
  ...(await original<typeof import("../src/services/autopay")>()),
  chargeDueAutopay: autopay.charge,
  runAutopayJob: autopay.job,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
};

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
}

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("weather holds", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const days = [0, 1, 2, 3].map((i) => addDays(today, i));
  // Tomorrow is cold and wet.
  const forecast = { daily: { time: days, temperature_2m_min: [55, 35, 55, 55], temperature_2m_max: [70, 50, 70, 70], precipitation_probability_max: [10, 90, 10, 10] } };
  // What the Lawn & Exterior preset saves in settings.weather_rules at signup, for a business that picked Open-Meteo.
  const company = { weather_source: "open_meteo", weather_rules: [{ applies_to: "Weekly mow", max_rain_pct: 70 }, { applies_to: "House power wash", min_temp_f: 40 }] };
  const visit = (id: string, job: unknown) => ({ id, scheduled_on: tomorrow, hold_reason: null, job, company, property: { lat: 37.13, lng: -80.41 } });

  it("uses the company's rules for the services on a job that has none of its own", async () => {
    const visits = [
      visit("mow", { weather_rules: [], lines: [{ name: "Mowing, front and back", service: { name: "Weekly mow" } }] }),
      visit("wash", { weather_rules: [], lines: [{ name: "House power wash", service: null }] }),
      visit("gutters", { weather_rules: [], lines: [{ name: "Gutter cleaning", service: null }] }),
      // The job's own rules come first: it's fine with rain up to 95%.
      visit("own", { weather_rules: [{ max_rain_pct: 95 }], lines: [{ name: "Weekly mow", service: null }] }),
      visit("task", null),
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 5, flagged: 2, unknown: 0 });
    const holds = calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => ({ id: c.url.searchParams.get("id"), hold: c.body.hold_reason }));
    expect(holds).toEqual([
      { id: "eq.mow", hold: "Weekly mow: 90% chance of rain" },
      { id: "eq.wash", hold: "House power wash: low of 35°F is below 40°F" },
    ]);
  });

  it("finds a rule's price list item by its id first, so renaming the item keeps the rule", async () => {
    const byId = { weather_source: "open_meteo", weather_rules: [{ service_id: "svc-mow", applies_to: "Weekly mow", max_rain_pct: 70 }, { service_id: "svc-wash", applies_to: "House power wash", min_temp_f: 40 }] };
    const visits = [
      // Weekly mow is called Lawn mowing now; the rule follows it, by its new name.
      { ...visit("mow", { weather_rules: [], lines: [{ name: "Mowing", service_id: "svc-mow", service: { name: "Lawn mowing" } }] }), company: byId },
      // A line of the rule's old name, from another item, isn't that item.
      { ...visit("other", { weather_rules: [], lines: [{ name: "House power wash", service_id: "svc-other", service: { name: "House power wash" } }] }), company: { weather_source: "open_meteo", weather_rules: [{ service_id: "svc-wash", min_temp_f: 40 }] } },
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 2, flagged: 1, unknown: 0 });
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => [c.url.searchParams.get("id"), c.body.hold_reason])).toEqual([["eq.mow", "Lawn mowing: 90% chance of rain"]]);
    expect(calls.find((c) => c.method === "GET" && c.path === "visits")?.url.searchParams.get("select")).toContain("lines:job_line_items(name,service_id,");
  });

  it("reads every visit a page at a time, in a fixed order", async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => visit(`v${start + i}`, { weather_rules: [], lines: [] }));
    const calls = serve((call) => {
      if (call.method !== "GET" || call.path !== "visits") return [];
      return Number(call.url.searchParams.get("offset")) === 0 ? page(0, 1000) : page(1000, 1);
    });
    expect(await runTask("weather", env)).toMatchObject({ checked: 1001 });
    const reads = calls.filter((c) => c.path === "visits").map((c) => [c.url.searchParams.get("order"), c.url.searchParams.get("offset"), c.url.searchParams.get("limit")]);
    expect(reads).toEqual([
      ["id.asc", "0", "1000"],
      ["id.asc", "1000", "1000"],
    ]);
  });
});

describe("snow by tomorrow", () => {
  const tomorrow = "2026-01-16";
  const days = ["2026-01-15", tomorrow, "2026-01-17"];
  // Snow at noon today, which is today's, then a storm overnight: some at 9pm and the rest at 2am.
  const storm = (noon: number, evening: number, morning: number) => ({
    daily: { time: days, temperature_2m_min: [20, 20, 20], temperature_2m_max: [30, 30, 30], precipitation_probability_max: [0, 90, 0] },
    hourly: { time: ["2026-01-15T12:00", "2026-01-15T21:00", "2026-01-16T02:00"], snowfall: [noon, evening, morning], temperature_2m: [28, 27, 25], weather_code: [3, 73, 73] },
  });
  // Rain at 7pm at 38°, then 26° by 2am: nothing to plow, plenty to salt.
  const thaw = { daily: storm(0, 0, 0).daily, hourly: { time: ["2026-01-15T19:00", "2026-01-16T02:00"], snowfall: [0, 0], temperature_2m: [38, 26], weather_code: [61, 3] } };
  const site = (id: string, name: string, lat: number | null, over: Record<string, unknown> = {}) => ({
    job_id: id, trigger_in: 3, salt_trigger_in: null, repeat_in: null, clear_by: null, priority: 2, alerted_on: null, alerted_pushes: null, ice_alerted_on: null,
    job: { title: "Plowing", status: "active", paused_at: null, client: { display_name: name }, property: { line1: "1 Maple Way", lat, lng: lat == null ? null : -111.64 } },
    ...over,
  });
  // The plaza gets 2.1 inches before midnight and 2.1 after: 4.2 for the storm, over its trigger of 3
  // (though neither date's own snow is) and, pushing again every inch, two pushes. Everyone else gets
  // 1, after 5 at noon today that isn't tomorrow's: nothing for the church, a salt run for the bank,
  // which salts from half an inch. The dentist's property isn't on the map.
  const sites = [
    site("plaza", "Maple Plaza", 40.59, { repeat_in: 1, clear_by: "07:00:00", priority: 1 }),
    site("church", "First Church", 44.27),
    site("bank", "First Bank", 44.27, { salt_trigger_in: 0.5 }),
    site("dentist", "Birch Dental", null),
  ];
  const forecastFor = (call: Call) => call.url.searchParams.get("latitude")!.split(",").map((lat) => (lat === "40.5900" ? storm(0, 2.1, 2.1) : storm(5, 0.5, 0.5)));
  const marked = (call: Call) => call.url.searchParams.get("job_id")!.replace(/^in\.\(|\)$/g, "").split(",").map((job_id) => ({ job_id }));
  /** The database and the forecast for one business with Snow installed, in New York, that picked Open-Meteo. */
  const snowDay = (over: (call: Call) => Response | unknown = () => undefined) =>
    serve((call) => {
      const mine = over(call);
      if (mine !== undefined) return mine;
      if (call.url.host === "api.open-meteo.com") return forecastFor(call);
      if (call.path === "companies") return [{ id: "co", timezone: "America/New_York", weather_source: "open_meteo" }];
      if (call.path === "snow_sites" && call.method === "GET") return sites;
      if (call.path === "snow_sites" && call.method === "PATCH") return marked(call);
      if (call.path === "rpc/snow_recipients") {
        return [{ job_id: "plaza", user_id: "lena", office: false }, { job_id: "plaza", user_id: "otto", office: true }, { job_id: "bank", user_id: "sam", office: false }, { job_id: "bank", user_id: "otto", office: true }]
          .filter((r) => (call.body.p_jobs as string[]).includes(r.job_id));
      }
      // Sam is a sub; Lena works for the business.
      if (call.path === "memberships") return [{ user_id: "sam" }].filter((m) => call.url.searchParams.get("user_id")!.includes(m.user_id));
      return [];
    });
  // The clock, set for each test: 17:00 UTC is noon in New York.
  const at = (time: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(time) });
  const told = (calls: Call[]) => calls.filter((c) => c.path === "notifications").flatMap((c) => c.body as Array<{ user_id: string; title: string; body: string; link: string }>);
  afterEach(() => vi.useRealTimers());

  it("is checked every hour (snowWatch), as the forecast changes", () => {
    expect(TASKS).toContain("snow");
    expect(CRON_TASKS["40 * * * *"]).toEqual(["snow"]);
    expect([0, 9, 23].every((h) => cronMatches("40 * * * *", new Date(Date.UTC(2026, 0, 15, h, 40))))).toBe(true);
  });

  it("tells a customer's people and the schedulers what the snow from 6pm today through tomorrow calls for: the plow, so many times, or salt", async () => {
    at("2026-01-15T17:00:00Z");
    const calls = snowDay();
    expect(await runTask("snow", env)).toEqual({ companies: 1, alerted: 2, iced: 0, logged: 0, unknown: 0 });
    // Businesses with Snow, and their snow customers whose jobs are active and not paused.
    expect(calls.find((c) => c.path === "companies")!.url.searchParams.get("settings->snow_app->>enabled")).toBe("eq.true");
    const read = calls.find((c) => c.path === "snow_sites" && c.method === "GET")!.url.searchParams;
    expect([read.get("company_id"), read.get("job.status"), read.get("job.paused_at")]).toEqual(["eq.co", "eq.active", "is.null"]);
    // One request for both places, snowfall in inches; the property that isn't on the map isn't asked about.
    const forecasts = calls.filter((c) => c.url.host === "api.open-meteo.com");
    expect(forecasts.map((c) => [c.url.searchParams.get("latitude"), c.url.searchParams.get("precipitation_unit")])).toEqual([["40.5900,44.2700", "inch"]]);
    expect(forecasts[0]!.url.searchParams.get("hourly")).toContain("snowfall");
    // Marked first, each with how many pushes its people are told, and only where that's news.
    expect(calls.filter((c) => c.path === "snow_sites" && c.method === "PATCH").map((c) => [c.body, c.url.searchParams.get("job_id"), c.url.searchParams.get("or")])).toEqual([
      [{ alerted_on: tomorrow, alerted_pushes: 2 }, "in.(plaza)", `(alerted_on.is.null,alerted_on.neq.${tomorrow},alerted_pushes.lt.2)`],
      [{ alerted_on: tomorrow, alerted_pushes: 0 }, "in.(bank)", `(alerted_on.is.null,alerted_on.neq.${tomorrow},alerted_pushes.lt.0)`],
    ]);
    const plaza = "Maple Plaza – 1 Maple Way: 4.2 in from 6pm tonight through tomorrow, trigger 3 in, 2 pushes, clear by 7 AM";
    const bank = "First Bank – 1 Maple Way: 1 in from 6pm tonight through tomorrow, salt only (it plows at 3 in)";
    const ask = "Can you go out? Say yes or no on My day.";
    expect(told(calls)).toEqual([
      // Lena works for the business, so she's told. Sam is a sub, so he's asked.
      { company_id: "co", user_id: "lena", kind: "snow", title: "Snow by tomorrow at Maple Plaza – 1 Maple Way: 4.2 in forecast", body: plaza, link: "/field" },
      { company_id: "co", user_id: "sam", kind: "snow", title: "Salt run by tomorrow at First Bank – 1 Maple Way: 1 in forecast", body: `${bank}\n${ask}`, link: "/field" },
      // The schedulers hear about both, the first priority first, and aren't asked.
      { company_id: "co", user_id: "otto", kind: "snow", title: "Snow by tomorrow: 2 properties to service", body: `${plaza}\n${bank}`, link: "/snow" },
    ]);
    // The storm goes in the log, and the subs who'd go out are asked whether they can.
    expect(calls.find((c) => c.path === "snow_events" && c.method === "POST")!.body).toEqual([
      { company_id: "co", job_id: "plaza", snow_date: tomorrow, kind: "plow", forecast_in: 4.2, pushes: 2 },
      { company_id: "co", job_id: "bank", snow_date: tomorrow, kind: "salt", forecast_in: 1, pushes: 1 },
    ]);
    const subs = calls.find((c) => c.path === "memberships")!.url.searchParams;
    expect([subs.get("company_id"), subs.get("role"), subs.get("user_id")]).toEqual(["eq.co", "eq.subcontractor", "in.(lena,sam)"]);
    expect(calls.find((c) => c.path === "snow_availability")!.body).toEqual([{ company_id: "co", snow_date: tomorrow, user_id: "sam" }]);
  });

  it("tells them again when the forecast grows into more pushes, and not when it doesn't, or when another server marked it first", async () => {
    at("2026-01-15T17:00:00Z");
    const toldAbout = (pushes: number) => [{ ...sites[0]!, alerted_on: tomorrow, alerted_pushes: pushes }];
    let calls = snowDay((call) => (call.path === "snow_sites" && call.method === "GET" ? toldAbout(2) : undefined));
    expect(await runTask("snow", env)).toMatchObject({ alerted: 0 });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    calls = snowDay((call) => (call.path === "snow_sites" && call.method === "GET" ? toldAbout(1) : undefined));
    expect(await runTask("snow", env)).toMatchObject({ alerted: 1 });
    expect(told(calls).map((n) => n.user_id)).toEqual(["lena", "otto"]);
    calls = snowDay((call) => (call.path === "snow_sites" && call.method === "PATCH" ? [] : undefined));
    expect(await runTask("snow", env)).toMatchObject({ alerted: 0 });
    expect(calls.some((c) => c.path === "notifications" || c.path === "rpc/snow_recipients")).toBe(false);
  });

  it("warns a salting customer's people of a refreeze, once, and nobody else", async () => {
    at("2026-01-15T17:00:00Z");
    const calls = snowDay((call) => (call.url.host === "api.open-meteo.com" ? call.url.searchParams.get("latitude")!.split(",").map(() => thaw) : undefined));
    expect(await runTask("snow", env)).toEqual({ companies: 1, alerted: 0, iced: 1, logged: 0, unknown: 0 });
    const mark = calls.find((c) => c.path === "snow_sites" && c.method === "PATCH")!;
    expect([mark.body, mark.url.searchParams.get("job_id"), mark.url.searchParams.get("or")]).toEqual([{ ice_alerted_on: tomorrow }, "in.(bank)", `(ice_alerted_on.is.null,ice_alerted_on.neq.${tomorrow})`]);
    expect(told(calls).map((n) => [n.user_id, n.title, n.body])).toEqual([
      ["sam", "Refreeze by tomorrow at First Bank – 1 Maple Way", "First Bank – 1 Maple Way: wet, then 26° by 2 AM tomorrow: it will refreeze"],
      ["otto", "Refreeze by tomorrow at First Bank – 1 Maple Way", "First Bank – 1 Maple Way: wet, then 26° by 2 AM tomorrow: it will refreeze"],
    ]);
  });

  it("tells nobody outside 10am to 10pm the business's time, but still writes what fell yesterday into the log", async () => {
    for (const time of ["2026-01-15T14:59:00Z", "2026-01-16T03:00:00Z"]) {
      at(time);
      const calls = snowDay();
      expect(await runTask("snow", env)).toEqual({ companies: 0, alerted: 0, iced: 0, logged: 0, unknown: 0 });
      expect(calls.map((c) => c.path)).toEqual(["companies", "snow_events"]);
    }
    at("2026-01-15T14:00:00Z");
    // Yesterday's storm at the plaza has no amount yet: the forecast's own look back fills it in.
    const calls = snowDay((call) =>
      call.path === "snow_events" && call.method === "GET" ? [{ job_id: "plaza", job: { property: { lat: 40.59, lng: -111.64 } } }]
        : call.url.host === "api.open-meteo.com" ? [{ hourly: { time: ["2026-01-13T20:00", "2026-01-14T03:00", "2026-01-15T05:00"], snowfall: [1.5, 2.25, 9] } }]
          : undefined,
    );
    expect(await runTask("snow", env)).toMatchObject({ logged: 1 });
    const asked = calls.find((c) => c.path === "snow_events" && c.method === "GET")!.url.searchParams;
    expect([asked.get("snow_date"), asked.get("actual_in"), calls.find((c) => c.url.host === "api.open-meteo.com")!.url.searchParams.get("past_days")]).toEqual(["eq.2026-01-14", "is.null", "2"]);
    const saved = calls.find((c) => c.path === "snow_events" && c.method === "PATCH")!;
    // 1.5 from 8pm the evening before, plus 2.25 on the day; never over a figure someone wrote.
    expect([saved.body, saved.url.searchParams.get("job_id"), saved.url.searchParams.get("actual_in")]).toEqual([{ actual_in: 3.75 }, "eq.plaza", "is.null"]);
  });

  it("goes by the business's own forecast source, and doesn't take a forecast it couldn't get for a clear day", async () => {
    at("2026-01-15T17:00:00Z");
    // A business that never chose goes by the National Weather Service, which has nothing for these places here: Open-Meteo answers for them.
    let calls = snowDay((call) => (call.path === "companies" ? [{ id: "co", timezone: "America/New_York", weather_source: null }] : call.url.host === "api.weather.gov" ? new Response("not found", { status: 404 }) : undefined));
    expect(await runTask("snow", env)).toMatchObject({ alerted: 2 });
    expect([...new Set(calls.filter((c) => c.url.host !== "example.supabase.co").map((c) => c.url.host))]).toEqual(["api.weather.gov", "api.open-meteo.com"]);
    calls = snowDay((call) => (call.url.host === "api.open-meteo.com" ? new Response("busy", { status: 429 }) : undefined));
    expect(await runTask("snow", env)).toEqual({ companies: 1, alerted: 0, iced: 0, logged: 0, unknown: 3 });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("unmarks the customers when nobody could be told, so the next hour tries again", async () => {
    at("2026-01-15T17:00:00Z");
    const calls = snowDay((call) => (call.path === "notifications" ? Response.json({ message: "the database is busy" }, { status: 503 }) : undefined));
    await expect(runTask("snow", env)).rejects.toThrow("the database is busy");
    expect(calls.filter((c) => c.path === "snow_sites" && c.method === "PATCH").at(-1)!.body).toEqual({ alerted_on: null, alerted_pushes: null });
    expect(calls.some((c) => c.path === "snow_events" && c.method === "POST")).toBe(false);
  });
});

describe("hourly upkeep", () => {
  it("runs every step even when one fails, and reports the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => {
      if (call.path === "rpc/mark_overdue_invoices") return Response.json({ code: "22023", message: 'time zone "Not/AZone" not recognized', details: null, hint: null }, { status: 400 });
      if (call.path === "rpc/add_late_fees") return 6;
      if (call.path === "rpc/emit_invoice_reminders") return 7;
      if (call.path === "rpc/emit_visit_reminders") return 2;
      if (call.path === "rpc/emit_equipment_alerts") return 1;
      if (call.path === "rpc/emit_equipment_document_alerts") return 3;
      if (call.path === "rpc/emit_guide_reviews") return 2;
      if (call.path === "rpc/expire_sub_offers") return 3;
      // Two certificates running out; the subs have no email or phone to remind.
      if (call.path === "rpc/emit_sub_document_alerts") return [{ remind_sub: false }, { remind_sub: false }];
      if (call.path === "rpc/emit_card_expiry_alerts") return 5;
      if (call.path === "rpc/clock_upkeep") return { reminded: 1, stopped: 0 };
      if (call.path === "rpc/tidy_sign_in_codes") return 4;
      throw new Error(`unexpected ${call.path}`);
    });
    autopay.reconcile.mockResolvedValueOnce(2);
    autopay.bank.mockResolvedValueOnce(1);
    expect(await runTask("followups", env)).toEqual({
      overdue: 0,
      late_fees: 6,
      invoice_reminders: 7,
      reminders: 2,
      equipment: 1,
      paperwork: 3,
      guide_reviews: 2,
      offers: 3,
      subs: { alerts: 2, reminded: { subs: 0, email: 0, sms: 0, failed: 0 } },
      cards: 5,
      autopay_processing: 2,
      bank_payments: 1,
      clocks: { reminded: 1, stopped: 0 },
      codes: 4,
      problems: ['mark_overdue_invoices: time zone "Not/AZone" not recognized'],
    });
    // Cards expiring next month are flagged before the clocks.
    expect(calls.map((c) => c.path)).toEqual([
      "rpc/mark_overdue_invoices", "rpc/add_late_fees", "rpc/emit_invoice_reminders", "rpc/emit_visit_reminders", "rpc/emit_equipment_alerts", "rpc/emit_equipment_document_alerts", "rpc/emit_guide_reviews", "rpc/expire_sub_offers",
      "rpc/emit_sub_document_alerts", "rpc/emit_card_expiry_alerts", "rpc/clock_upkeep", "rpc/tidy_sign_in_codes",
    ]);
    expect(autopay.reconcile).toHaveBeenCalledWith(env, expect.anything());
    expect(autopay.bank).toHaveBeenCalledWith(env, expect.anything());
    expect(error).toHaveBeenCalled();
  });

  it("asks for monthly jobs' invoice reminders every hour, on the database's clock in each company's zone, and reports what each run made", async () => {
    // The database keeps one reminder a job a month (emit_invoice_reminders), so the second run makes none.
    const made = [2, 0];
    const calls = serve((call) => (call.path === "rpc/emit_invoice_reminders" ? made.shift() : call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : 0));
    expect(CRON_TASKS["0 * * * *"]).toContain("followups");
    expect(((await runTask("followups", env)) as { invoice_reminders: number }).invoice_reminders).toBe(2);
    expect(((await runTask("followups", env)) as { invoice_reminders: number }).invoice_reminders).toBe(0);
    expect(calls.filter((c) => c.path === "rpc/emit_invoice_reminders").map((c) => c.body ?? {})).toEqual([{}, {}]);
  });

  it("reads autopay's bank payments back from Stripe, and keeps going when Stripe can't be asked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : call.path.startsWith("rpc/") ? 0 : []));
    autopay.reconcile.mockRejectedValueOnce(new Error("Stripe didn't answer"));
    const out = (await runTask("followups", env)) as { cards: number; autopay_processing: number; problems: string[] };
    expect(out).toMatchObject({ cards: 0, autopay_processing: 0, problems: ["reconcile_autopay_processing: Stripe didn't answer"] });
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["rpc/clock_upkeep", "rpc/tidy_sign_in_codes"]);
  });

  it("reads clients' own bank payments back too, and keeps going when Stripe can't be asked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : call.path.startsWith("rpc/") ? 0 : []));
    autopay.bank.mockRejectedValueOnce(new Error("Stripe didn't answer"));
    const out = (await runTask("followups", env)) as { autopay_processing: number; bank_payments: number; problems: string[] };
    expect(out).toMatchObject({ autopay_processing: 0, bank_payments: 0, problems: ["reconcile_bank_payments: Stripe didn't answer"] });
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["rpc/clock_upkeep", "rpc/tidy_sign_in_codes"]);
    autopay.bank.mockResolvedValueOnce(3);
    expect(((await runTask("followups", env)) as { bank_payments: number }).bank_payments).toBe(3);
  });

  it("only promises subs a link the server can send, and keeps going when reminding them fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alert = { company_id: "co-1", subcontractor_id: "sub-1", document_id: "doc-1", kind: "liability", expires_on: "2026-11-24", days_left: 30, alert: "d30", remind_sub: true };
    const calls = serve((call) => {
      if (call.path === "rpc/emit_sub_document_alerts") return [alert];
      if (call.path === "subcontractors") return Response.json({ code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }, { status: 500 });
      if (call.path === "companies") return [];
      if (call.path === "rpc/clock_upkeep") return { reminded: 0, stopped: 0 };
      if (call.path.startsWith("rpc/")) return 0;
      throw new Error(`unexpected ${call.path}`);
    });
    const texting = { ...env, APP_URL: "https://ops.example.com", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15405550000" };
    const out = (await runTask("followups", texting)) as { subs: unknown; problems: string[] };
    expect(calls.find((c) => c.path === "rpc/emit_sub_document_alerts")?.body).toEqual({ p_can_text: true, p_can_email: false });
    expect(out.subs).toEqual({ alerts: 1, reminded: null });
    expect(out.problems).toEqual([expect.stringMatching(/^remind_subs: canceling statement/)]);
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["rpc/clock_upkeep", "rpc/tidy_sign_in_codes"]);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("clock_upkeep"), expect.anything());

    // Without the app's address there's no link to send, so nothing is promised.
    const quiet = serve((call) => (call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : 0));
    await runTask("followups", { ...texting, APP_URL: undefined });
    expect(quiet.find((c) => c.path === "rpc/emit_sub_document_alerts")?.body).toEqual({ p_can_text: false, p_can_email: false });
  });
});

describe("the Trash", () => {
  it("is emptied every night, after the plans sweep, of what's been there 30 days", async () => {
    expect(CRON_TASKS["35 4 * * *"]).toEqual(["trash"]);
    expect(CRON_TASKS["20 4 * * *"]).toEqual(["plans"]);
    const calls = serve(() => []);
    expect(await runTask("trash", env)).toEqual({ files: 0, folders: 0, other: 0, kept: 0 });
    // The database decides what's due (plan files, then Drive's folders, then files from the rest of
    // Crewtavo); nothing is removed when nothing is.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/trash_purge"]);
    expect(calls[0]!.body).toEqual({ p_cutoff: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), p_limit: 1000 });
  });
});

describe("review reminders", () => {
  it("are sent every five minutes, at 1:30pm in each company's time zone (services/reviews.ts)", async () => {
    expect(TASKS).toContain("reviews");
    expect(CRON_TASKS["*/5 * * * *"]).toContain("reviews");
    const calls = serve(() => []);
    expect(await runTask("reviews", { ...env, APP_URL: "https://ops.example.com" })).toEqual({ claimed: 0, sent: 0, failed: 0, stopped: 0, waiting: 0, lost: 0, errors: 0 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/claim_review_reminders"]);
  });
});

describe("Google reviews", () => {
  it("come in every 30 minutes for each company that's due (services/googleReviews.ts), with a tally", async () => {
    expect(TASKS).toContain("review_sync");
    expect(CRON_TASKS["12,42 * * * *"]).toEqual(["review_sync"]);
    expect([12, 42].every((m) => cronMatches("12,42 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m, 0, 250))))).toBe(true);
    expect([0, 11, 30, 43].some((m) => cronMatches("12,42 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m))))).toBe(false);
    const calls = serve((call) => {
      if (call.path === "rpc/review_syncs_due") return ["co-1", "co-2"];
      // co-1 is being synced by another worker; co-2 has Marketing uninstalled since.
      if (call.path === "rpc/claim_review_sync") return call.body.p_company === "co-1" ? null : "claim-2";
      if (call.path === "companies") return [{ settings: { marketing: { enabled: false } } }];
      return [];
    });
    expect(await runTask("review_sync", env)).toEqual({ due: 2, synced: 0, waiting: 2, problems: 0, errors: 0 });
    expect(calls.find((c) => c.path === "rpc/review_syncs_due")!.body).toEqual({ p_limit: 25 });
    expect(calls.some((c) => c.url.host !== "example.supabase.co")).toBe(false);
  });
});

describe("social posts", () => {
  it("go every minute, one claim at a time (services/social.ts), with a tally", async () => {
    expect(TASKS).toContain("social");
    expect(CRON_TASKS["* * * * *"]).toContain("social");
    const calls = serve(() => []);
    expect(await runTask("social", env)).toEqual({ claimed: 0, errors: 0 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/claim_social_posts"]);
    expect(calls[0]!.body).toEqual({ p_limit: 1, p_hold_seconds: 300 });
  });
});

describe("clients who haven't had a visit in a while", () => {
  it("are queued hourly, for each company that can email them, at most 100 a day for each rule (services/automatedCampaigns.ts)", async () => {
    expect(TASKS).toContain("inactive");
    expect(CRON_TASKS["5 * * * *"]).toEqual(["inactive"]);
    // The scheduler's minute check runs it at five past each hour, and only then.
    expect(cronMatches("5 * * * *", new Date("2026-10-27T14:05:30Z"))).toBe(true);
    expect([0, 4, 6, 35].some((m) => cronMatches("5 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m))))).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T14:05:00Z") });
    try {
      const calls = serve((call) => {
        if (call.method === "GET" && call.path === "automation_rules") return [{ company_id: "co-1" }, { company_id: "co-1" }, { company_id: "co-2" }];
        if (call.path === "rpc/emit_inactive_clients") return call.body.p_company === "co-1" ? 3 : 1;
        return [];
      });
      const sending = { ...env, APP_URL: "https://ops.example.com", RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <noreply@example.com>" };
      expect(await runTask("inactive", sending)).toEqual({ companies: 2, queued: 4, waiting: 0 });
      const rules = calls.find((c) => c.path === "automation_rules")!;
      expect([rules.url.searchParams.get("trigger"), rules.url.searchParams.get("enabled"), rules.url.searchParams.get("company.settings->marketing->>enabled")]).toEqual(["eq.client.inactive", "eq.true", "eq.true"]);
      expect(calls.filter((c) => c.path.startsWith("rpc/")).map((c) => [c.path, c.body])).toEqual([
        ["rpc/emit_inactive_clients", { p_now: "2026-10-27T14:05:00.000Z", p_cap: 100, p_company: "co-1" }],
        ["rpc/emit_inactive_clients", { p_now: "2026-10-27T14:05:00.000Z", p_cap: 100, p_company: "co-2" }],
      ]);

      // Without a way to send them, they wait: the runs would only fail and use up each client's turn.
      const quiet = serve((call) => (call.method === "GET" && call.path === "automation_rules" ? [{ company_id: "co-1" }] : []));
      expect(await runTask("inactive", { ...sending, APP_URL: undefined })).toEqual({ companies: 1, queued: 0, waiting: 1 });
      expect(quiet.some((c) => c.path === "rpc/emit_inactive_clients")).toBe(false);
      // Nor while the company has no mailbox and the server sends no email of its own.
      const unconnected = serve((call) => (call.method === "GET" && call.path === "automation_rules" ? [{ company_id: "co-1" }] : []));
      expect(await runTask("inactive", { ...env, APP_URL: "https://ops.example.com" })).toEqual({ companies: 1, queued: 0, waiting: 1 });
      expect(unconnected.some((c) => c.path === "rpc/emit_inactive_clients")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the nightly tidy-up", () => {
  it("also removes guide covers and quote and visit photos nobody recorded", async () => {
    const calls = serve((call) => (call.path === "companies" ? [] : call.path === "rpc/unrecorded_files" ? [{ company_id: "co-1", paths: ["co-1/kb/stray.jpg"] }] : []));
    expect(await runTask("plans", env)).toEqual({ unrecorded: 0, subs: { unrecorded: 0 }, applicants: { unrecorded: 0 }, photos: { unrecorded: 1, kept: 0 }, social: 0, meta: { checked: 0, signin: 0, expiring: 0 } });
    expect(calls.find((c) => c.path === "rpc/unrecorded_files")?.body).toEqual({ p_limit: 1000 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.body)).toEqual([{ prefixes: ["co-1/kb/stray.jpg"] }]);
  });
});

describe("autopay", () => {
  it("charges what's due every 5 minutes, alongside the outbox that sends its receipts", async () => {
    expect(CRON_TASKS["*/5 * * * *"]).toEqual(["outbox", "reviews", "autopay"]);
    const result = { claimed: 2, charged: 1, processing: 0, needs_approval: 0, called_off: 0, failed: 1, needs_client: 0, busy: 0, retry: 0, lost: 0 };
    autopay.charge.mockResolvedValueOnce(result);
    expect(await runTask("autopay", env)).toEqual(result);
    expect(autopay.charge).toHaveBeenCalledWith(env);
  });

  it("hands the outbox's autopay jobs to the autopay service, and a job that keeps failing shows on Stripe's app", async () => {
    const rows = [
      { id: 1, company_id: "co-1", topic: "autopay.receipt", payload: { charge_id: "ch-1" }, attempts: 1 },
      { id: 2, company_id: "co-1", topic: "autopay.notice", payload: { charge_id: "ch-2", status: "failed", failures: 1 }, attempts: 8 },
      { id: 3, company_id: "co-1", topic: "autopay.agreed", payload: { authorization_id: "au-1" }, attempts: 1 },
    ];
    autopay.job.mockImplementation(async (_env: Env, _admin: unknown, row: { topic: string }) => {
      if (row.topic === "autopay.notice") throw new Error("Resend is having trouble right now. Try again in a few minutes.");
    });
    const calls = serve((call) => (call.path === "rpc/claim_outbox" ? rows : []));
    expect(await runTask("outbox", env)).toEqual({ claimed: 3, done: 2, failed: 1 });
    expect(autopay.job.mock.calls.map((c) => c[2])).toEqual(rows.map(({ company_id, topic, payload }) => ({ company_id, topic, payload })));
    const outbox = calls.filter((c) => c.method === "PATCH" && c.path === "outbox");
    expect(outbox.map((c) => [c.url.searchParams.get("id"), Boolean(c.body.done_at), Boolean(c.body.dead_at)])).toEqual([
      ["eq.1", true, false],
      ["eq.2", false, true],
      ["eq.3", true, false],
    ]);
    const marked = calls.find((c) => c.method === "PATCH" && c.path === "integrations")!;
    expect(marked.url.searchParams.get("provider")).toBe("in.(stripe)");
    expect(marked.body).toEqual({ last_error: "Resend is having trouble right now. Try again in a few minutes." });
    // Nothing went to Stripe's invoice sync or the books.
    expect(calls.some((c) => c.url.host === "api.stripe.com")).toBe(false);
  });
});
