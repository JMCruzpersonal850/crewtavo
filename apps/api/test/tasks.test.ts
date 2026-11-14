/**
 * Background tasks against a stand-in for PostgREST and the forecast: fetch is stubbed, and each
 * test answers the requests it expects. (What the database functions do is tested in supabase/tests.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { addDays } from "@crewtavo/core";
import { isFresh, REVIEW_FRESH_DAYS, reviewsFreshSince } from "@crewtavo/core/reviews";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cronMatches } from "../src/lib/cron";
import { HttpError } from "../src/lib/http";
import { CRON_TASKS, runTask, TASKS } from "../src/tasks";

// Autopay's own work is tested in autopay.test.ts and the Stripe tests; here, only that the tasks call it.
const autopay = vi.hoisted(() => ({ reconcile: vi.fn(async () => 0), bank: vi.fn(async () => 0), charge: vi.fn(), job: vi.fn() }));
vi.mock("../src/integrations/stripe", async (original) => ({
  ...(await original<typeof import("../src/integrations/stripe")>()),
  reconcileAutopayProcessing: autopay.reconcile,
  reconcileBankPayments: autopay.bank,
}));
// Sending an invoice is sales.test.ts's; here, only what the installments task sends and how it settles each.
const sales = vi.hoisted(() => ({ sendInvoice: vi.fn() }));
vi.mock("../src/services/sales", async (original) => ({
  ...(await original<typeof import("../src/services/sales")>()),
  sendInvoice: sales.sendInvoice,
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
  // What the Lawn & Exterior preset saves in settings.weather_rules at signup.
  const company = { weather_rules: [{ applies_to: "Weekly mow", max_rain_pct: 70 }, { applies_to: "House power wash", min_temp_f: 40 }] };
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
    const byId = { weather_rules: [{ service_id: "svc-mow", applies_to: "Weekly mow", max_rain_pct: 70 }, { service_id: "svc-wash", applies_to: "House power wash", min_temp_f: 40 }] };
    const visits = [
      // Weekly mow is called Lawn mowing now; the rule follows it, by its new name.
      { ...visit("mow", { weather_rules: [], lines: [{ name: "Mowing", service_id: "svc-mow", service: { name: "Lawn mowing" } }] }), company: byId },
      // A line of the rule's old name, from another item, isn't that item.
      { ...visit("other", { weather_rules: [], lines: [{ name: "House power wash", service_id: "svc-other", service: { name: "House power wash" } }] }), company: { weather_rules: [{ service_id: "svc-wash", min_temp_f: 40 }] } },
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 2, flagged: 1, unknown: 0 });
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => [c.url.searchParams.get("id"), c.body.hold_reason])).toEqual([["eq.mow", "Lawn mowing: 90% chance of rain"]]);
    expect(calls.find((c) => c.method === "GET" && c.path === "visits")?.url.searchParams.get("select")).toContain("lines:job_line_items(name,service_id,");
  });

  it("holds an asphalt job priced with the paving calculator, whose one line has no price list item", async () => {
    // What the Paving preset saves at signup: its asphalt and sealcoat rules by item, and for the calculator.
    const paving = {
      weather_rules: [
        { applies_to: "Hot-mix asphalt surface", service_id: "svc-hot", min_temp_f: 50, max_rain_pct: 40 },
        { work: "asphalt", applies_to: "Hot-mix asphalt (paving calculator)", min_temp_f: 50, max_rain_pct: 40 },
        { work: "sealcoat", applies_to: "Sealcoat (paving calculator)", min_temp_f: 50, requires_dry_hours: 24 },
      ],
    };
    const parts = (work: string) => [{ id: "x", name: "Item", unit: "ton", quantity: 40, unit_cost: 100, work }, { id: "crew", name: "Full crew", unit: "day", quantity: 1, unit_cost: 5000 }];
    const visits = [
      { ...visit("pave", { weather_rules: [], lines: [{ name: "New asphalt paving", service_id: null, service: null, parts: parts("asphalt") }] }), company: paving },
      { ...visit("gravel", { weather_rules: [], lines: [{ name: "Gravel", service_id: null, service: null, parts: parts("stone") }] }), company: paving },
      // A calculator line from before lines kept their parts: no rule finds it, as before.
      { ...visit("old", { weather_rules: [], lines: [{ name: "New asphalt paving", service_id: null, service: null, parts: null }] }), company: paving },
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 3, flagged: 1, unknown: 0 });
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => [c.url.searchParams.get("id"), c.body.hold_reason])).toEqual([
      ["eq.pave", "Hot-mix asphalt (paving calculator): low of 35°F is below 50°F; Hot-mix asphalt (paving calculator): 90% chance of rain"],
    ]);
    expect(calls.find((c) => c.method === "GET" && c.path === "visits")?.url.searchParams.get("select")).toContain("lines:job_line_items(name,service_id,parts,");
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

describe("hourly upkeep", () => {
  it("runs every step even when one fails, and reports the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => {
      if (call.path === "rpc/mark_overdue_invoices") return Response.json({ code: "22023", message: 'time zone "Not/AZone" not recognized', details: null, hint: null }, { status: 400 });
      if (call.path === "rpc/raise_past_due_notices") return 2;
      if (call.path === "rpc/add_late_fees") return 6;
      if (call.path === "rpc/tell_unpaid_deposits") return 1;
      if (call.path === "rpc/make_due_installments") return 2;
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
      owed_again: 2,
      late_fees: 6,
      deposits: 1,
      installments: 2,
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
      "rpc/mark_overdue_invoices", "rpc/raise_past_due_notices", "rpc/add_late_fees", "rpc/tell_unpaid_deposits", "rpc/make_due_installments", "rpc/emit_invoice_reminders", "rpc/emit_visit_reminders", "rpc/emit_equipment_alerts", "rpc/emit_equipment_document_alerts", "rpc/emit_guide_reviews", "rpc/expire_sub_offers",
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

  it("are tidied once a day: copies the sync stopped seeing are removed, in one database call, with a tally", async () => {
    expect(TASKS).toContain("review_tidy");
    expect(CRON_TASKS["55 4 * * *"]).toEqual(["review_tidy"]);
    const calls = serve((call) => (call.path === "rpc/tidy_reviews" ? { removed: 3, blanked: 1, figures: 1, notices: 2 } : []));
    expect(await runTask("review_tidy", env)).toEqual({ removed: 3, blanked: 1, figures: 1, notices: 2 });
    // Nothing is asked of Google, and nobody's review asks are touched: the database leaves the clients as they were.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/tidy_reviews"]);
    serve(() => Response.json({ message: "down" }, { status: 500 }));
    await expect(runTask("review_tidy", env)).rejects.toThrow("down");
  });

  it("are kept for the same number of days by the server and the database", () => {
    const migration = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261113001860_google_reviews_kept_while_fresh.sql", import.meta.url)), "utf8");
    const days = [...migration.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1]));
    expect(days).toHaveLength(4);
    expect(new Set(days)).toEqual(new Set([REVIEW_FRESH_DAYS]));
    expect(REVIEW_FRESH_DAYS).toBeLessThan(30);
    const now = Date.UTC(2026, 10, 14, 12);
    expect(reviewsFreshSince(now)).toBe("2026-10-16T12:00:00.000Z");
    expect([isFresh("2026-10-16T12:00:01Z", now), isFresh("2026-10-16T12:00:00Z", now), isFresh(null, now)]).toEqual([true, false, false]);
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
    expect(await runTask("plans", env)).toEqual({ unrecorded: 0, subs: { unrecorded: 0 }, applicants: { unrecorded: 0 }, photos: { unrecorded: 1, kept: 0 }, social: 0, showcases: 0, meta: { checked: 0, signin: 0, expiring: 0 } });
    expect(calls.find((c) => c.path === "rpc/unrecorded_files")?.body).toEqual({ p_limit: 1000 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.body)).toEqual([{ prefixes: ["co-1/kb/stray.jpg"] }]);
  });
});

describe("scheduled payments", () => {
  it("sends each payment the database made, by email or by text to a client with only a phone, and settles each once", async () => {
    const withUrl = { ...env, APP_URL: "https://crew.example.com/" };
    const claimed = [
      { id: "in-1", company_id: "co-1", invoice_id: "inv-1" },
      { id: "in-2", company_id: "co-1", invoice_id: "inv-2" },
      { id: "in-3", company_id: "co-2", invoice_id: "inv-3" },
    ];
    const clients: Record<string, unknown> = { "inv-1": { email: "pat@example.com", phone: null }, "inv-2": { email: null, phone: "+15555550100" }, "inv-3": { email: "x@example.com", phone: null } };
    const calls = serve((call) => {
      if (call.path === "rpc/claim_installment_sends") return claimed;
      if (call.path === "invoices") return { status: "draft", client: clients[call.url.searchParams.get("id")!.replace("eq.", "")] };
      return null;
    });
    sales.sendInvoice.mockImplementation(async (_s: unknown, id: string) => {
      if (id === "inv-3") throw new HttpError(400, "Add a valid email address for this client first.");
      return { link: "x", sent: true };
    });
    expect(CRON_TASKS["*/5 * * * *"]).toContain("installments");
    expect(await runTask("installments", withUrl)).toEqual({ claimed: 3, sent: 2, failed: 1, called_off: 0 });
    expect(sales.sendInvoice.mock.calls.map((c) => [c[0].companyId, c[0].baseUrl, c[1], c[2]])).toEqual([
      ["co-1", "https://crew.example.com", "inv-1", { channel: "email" }],
      ["co-1", "https://crew.example.com", "inv-2", { channel: "sms" }],
      ["co-2", "https://crew.example.com", "inv-3", { channel: "email" }],
    ]);
    expect(calls.filter((c) => c.path === "rpc/installment_sent").map((c) => c.body)).toEqual([
      { p_installment: "in-1", p_sent: true },
      { p_installment: "in-2", p_sent: true },
      { p_installment: "in-3", p_sent: false, p_error: "Add a valid email address for this client first." },
    ]);
  });

  it("sends nothing without the server's web address, and says so to the office", async () => {
    sales.sendInvoice.mockReset();
    const calls = serve((call) => (call.path === "rpc/claim_installment_sends" ? [{ id: "in-1", company_id: "co-1", invoice_id: "inv-1" }] : null));
    expect(await runTask("installments", env)).toEqual({ claimed: 1, sent: 0, failed: 1, called_off: 0 });
    expect(sales.sendInvoice).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path === "rpc/installment_sent")?.body).toEqual({
      p_installment: "in-1", p_sent: false, p_error: "This server has no web address set (APP_URL), so it can't send links to clients",
    });
  });

  it("never sends an invoice the office already sent by hand, or one that's void or gone: the send is called off and nobody is told", async () => {
    sales.sendInvoice.mockReset();
    sales.sendInvoice.mockResolvedValue({ link: "x", sent: true });
    const withUrl = { ...env, APP_URL: "https://crew.example.com/" };
    const statuses: Record<string, unknown> = { "inv-1": { status: "sent", client: { email: "pat@example.com", phone: null } }, "inv-2": { status: "void", client: { email: "pat@example.com", phone: null } }, "inv-3": null, "inv-4": { status: "draft", client: { email: "pat@example.com", phone: null } } };
    const calls = serve((call) => {
      if (call.path === "rpc/claim_installment_sends") return ["1", "2", "3", "4"].map((n) => ({ id: `in-${n}`, company_id: "co-1", invoice_id: `inv-${n}` }));
      if (call.path === "invoices") return statuses[call.url.searchParams.get("id")!.replace("eq.", "")];
      return null;
    });
    expect(await runTask("installments", withUrl)).toEqual({ claimed: 4, sent: 1, failed: 0, called_off: 3 });
    expect(sales.sendInvoice.mock.calls.map((c) => c[1])).toEqual(["inv-4"]);
    expect(calls.filter((c) => c.path === "rpc/installment_send_called_off").map((c) => c.body)).toEqual([{ p_installment: "in-1" }, { p_installment: "in-2" }, { p_installment: "in-3" }]);
    expect(calls.filter((c) => c.path === "rpc/installment_sent").map((c) => c.body)).toEqual([{ p_installment: "in-4", p_sent: true }]);
  });
});

describe("autopay", () => {
  it("charges what's due every 5 minutes, alongside the outbox that sends its receipts", async () => {
    expect(CRON_TASKS["*/5 * * * *"]).toEqual(["outbox", "reviews", "autopay", "installments"]);
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
