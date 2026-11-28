/**
 * The AI voice agent (routes/voiceAgent.ts, services/voiceAgent.ts, lib/voiceAgent.ts): its
 * Apps-page connection, the webhook a finished call arrives on, and the two tools the agent
 * calls mid-call. The database is kept in memory (fixtures/memoryDb) with the booking
 * functions acted out the way onlineBooking.test.ts acts them out, and the company is set up
 * through the real PUT endpoint, so the tool token and webhook secret the tests use are the
 * ones Crewtavo itself made. Bookings go through the same form machinery as a booking form:
 * open 8 to 12 every day in New York, an hour a visit, a day's lead time — so on Monday
 * Nov 2, 2026 the first day offered is Tuesday the 3rd.
 */
import { zonedTimeToUtc } from "@crewtavo/core/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { StoredSecret } from "../src/integrations/tokens";
import { decryptJson, keyedHash } from "../src/lib/crypto";
import { memoryDb, type MemoryDb, type Row } from "./fixtures/memoryDb";

const world = vi.hoisted(() => ({ db: null as unknown as MemoryDb }));
vi.mock("../src/lib/supabase", async () => {
  const { memoryClient } = await import("./fixtures/memoryDb");
  return { adminClient: () => memoryClient(() => world.db), userClient: () => memoryClient(() => world.db), publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;

const NY = "America/New_York";
// Monday, Nov 2, 2026, 2 PM in New York.
const NOW = new Date("2026-11-02T19:00:00Z");
const CO = "00000000-0000-4000-8000-0000000000c1";
const FORM = "00000000-0000-4000-8000-0000000000f1";
const VISIT = "00000000-0000-4000-8000-0000000000a1";
const PLATFORM_KEY = "retell-key-123";
const at = (date: string, time: string) => zonedTimeToUtc(date, time, NY).toISOString();
const NINE = at("2026-11-03", "09:00");
const TEN = at("2026-11-03", "10:00");

const auth = { Authorization: "Bearer test-token", "X-Company-Id": CO, "Content-Type": "application/json" };
const get = (path: string, headers: Record<string, string> = auth) => app.request(`/api${path}`, { headers }, env);
const put = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  app.request(`/api${path}`, { method: "PUT", headers, body: JSON.stringify(body) }, env);
const post = (path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  app.request(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body) }, env);

interface WorldOptions {
  /** When whoever the form books is busy. */
  busy?: Array<{ starts_at: string; ends_at: string }>;
  /** The signed-in person's role in the company. */
  role?: string;
}

/** One company, its pick-a-time form, its price book, and the client bookings land on. */
function database(options: WorldOptions = {}) {
  world.db = memoryDb(
    {
      memberships: [{ company_id: CO, user_id: "viewer", active: true, role: options.role ?? "owner", role_id: null, subcontractor_id: null }],
      companies: [{
        id: CO, name: "Acme Roofing", phone: "540-555-0100", email: "office@acme.example", timezone: NY,
        address: { city: "Radford", state: "VA" }, trade_preset: "roofing",
        settings: { working_hours: { start: "08:00", end: "12:00", days: [0, 1, 2, 3, 4, 5, 6] } },
      }],
      services: [
        { company_id: CO, name: "Roof replacement", active: true, sort: 1 },
        { company_id: CO, name: "Roof repair", active: true, sort: 2 },
      ],
      intake_forms: [{
        id: FORM, company_id: CO, name: "Free roof inspection", kind: "assessment", lead_time_days: 1, slot_minutes: 60,
        max_per_day: null, requires_approval: false, pick_time: true, crew_id: null, active: true, created_at: "2026-10-01T00:00:00.000Z",
      }],
      clients: [{ id: "client-2", company_id: CO, display_name: "Bob Jones", email: "bob@example.com", phone: "540-555-0177", sms_opt_out_at: null }],
      integrations: [],
      integration_secrets: [],
      ai_calls: [],
      requests: [],
    },
    { integrations: ["company_id", "provider"], integration_secrets: ["company_id", "provider"] },
  );
  world.db.rpc.booking_busy_times = (args) => (options.busy ?? []).filter((b) => b.starts_at < String(args.p_to) && b.ends_at > String(args.p_from));
  world.db.rpc.booking_form_client = () => ({ client_id: "client-2", property_id: "property-2", matched: false, new_property: true });
  world.db.rpc.book_form_time = (args) => ({
    client_id: "client-2", property_id: "property-2", matched: false, new_property: true, request_id: "request-2", number: 1042,
    visit_id: VISIT, starts_at: args.p_starts_at, ends_at: new Date(Date.parse(String(args.p_starts_at)) + 3_600_000).toISOString(), booked: true,
  });
  world.db.rpc.call_off_visit_notice = () => 1;
  return world.db;
}

const rpcs = (fn: string) => world.db.rpcs.filter((r) => r.fn === fn);
const calls = () => world.db.tables.ai_calls!;
const requests = () => world.db.tables.requests!;

/** Connect the voice agent through the real endpoint; the state it answers carries our two secrets. */
async function connect() {
  const res = await put("/apps/voice/account", {
    platform: "retell", api_key: PLATFORM_KEY, agent_id: "agent-1", phone_number: "+15405550199",
    form_id: FORM, enabled: true, greeting: "", faqs: [],
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Row;
}

/** A Retell end-of-call report, as Retell posts it once its analysis is done. */
const retellCall = (callId: string, analysis: Row) => ({
  event: "call_analyzed",
  call: {
    call_id: callId,
    from_number: "+15405550163",
    to_number: "+15405550199",
    start_timestamp: Date.parse("2026-11-02T18:00:00Z"),
    end_timestamp: Date.parse("2026-11-02T18:01:34Z"),
    duration_ms: 94_000,
    transcript: "Agent: Thanks for calling Acme Roofing. Caller: Hi, about my roof…",
    recording_url: "https://recordings.example/call.mp3",
    call_analysis: { call_summary: "A call with Bob Jones.", custom_analysis_data: analysis },
  },
});
const webhook = (callId: string, analysis: Row, secret: string) =>
  post(`/webhooks/voice/${CO}/retell`, retellCall(callId, analysis), { "Content-Type": "application/json", "x-voice-secret": secret });

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Apps-page connection", () => {
  it("is dark before setup: not connected, no key, no token of ours", async () => {
    database();
    const res = await get("/apps/voice");
    expect(res.status).toBe(200);
    const state = (await res.json()) as Row;
    expect(state).toMatchObject({ connected: false, live: false, platform: null, has_api_key: false, tool_token: null, webhook_secret: null });
    expect(state.webhook_urls.retell).toBe(`https://ops.example.com/api/webhooks/voice/${CO}/retell`);
    expect(state.webhook_urls.vapi).toBe(`https://ops.example.com/api/webhooks/voice/${CO}/vapi`);
  });

  it("won't save for someone who isn't an admin", async () => {
    database({ role: "office" });
    const res = await put("/apps/voice/account", {
      platform: "retell", api_key: PLATFORM_KEY, agent_id: "agent-1", phone_number: "+15405550199", form_id: FORM, enabled: true, greeting: "", faqs: [],
    });
    expect(res.status).toBe(403);
    expect(world.db.tables.integrations).toEqual([]);
  });

  it("saves connected, makes the tool token and webhook secret once, and never hands the platform key back", async () => {
    database();
    const state = await connect();
    expect(state).toMatchObject({ connected: true, live: true, platform: "retell", agent_id: "agent-1", phone_number: "+15405550199", form_id: FORM, has_api_key: true });
    expect(typeof state.tool_token).toBe("string");
    expect(typeof state.webhook_secret).toBe("string");
    // The platform key is ours to keep, not to show: nowhere in the answer, nowhere plain in the database.
    expect(JSON.stringify(state)).not.toContain(PLATFORM_KEY);
    expect(JSON.stringify(world.db.tables)).not.toContain(PLATFORM_KEY);
    // Settings keep only the token's keyed hash; the secret itself decrypts to what was saved.
    const row = world.db.tables.integrations!.find((r) => r.provider === "voice_agent")!;
    expect((row.settings as Row).tool_token_hash).toBe(await keyedHash(env, state.tool_token as string));
    const kept = world.db.tables.integration_secrets!.find((r) => r.provider === "voice_agent")!;
    expect(await decryptJson<StoredSecret>(env, kept.ciphertext as string)).toEqual({
      api_key: PLATFORM_KEY,
      extra: { webhook_secret: state.webhook_secret, tool_token: state.tool_token },
    });
    // A later save with the key left blank keeps the stored key — and the same token and secret,
    // so a platform already pointed at them keeps working.
    const again = (await (await put("/apps/voice/account", {
      platform: "retell", agent_id: "agent-1", phone_number: "+15405550199", form_id: FORM, enabled: true, greeting: "", faqs: [],
    })).json()) as Row;
    expect(again).toMatchObject({ connected: true, has_api_key: true, tool_token: state.tool_token, webhook_secret: state.webhook_secret });
  });

  it("has no agent config before the settings are saved, and the whole config after", async () => {
    database();
    expect((await get("/apps/voice/agent-config")).status).toBe(400);
    const state = await connect();
    const res = await get("/apps/voice/agent-config");
    expect(res.status).toBe(200);
    const config = (await res.json()) as Row;
    expect(config.version).toBe(1);
    expect(config.greeting).toContain("Acme Roofing");
    expect(config.system_prompt).toContain("Roof replacement");
    expect(config.webhook.url).toBe(`https://ops.example.com/api/webhooks/voice/${CO}/retell`);
    const functions = (config.retell as Row).custom_functions as Row[];
    expect(functions.map((f) => f.name)).toEqual(["check_availability", "book_appointment"]);
    for (const fn of functions) expect((fn.headers as Row).Authorization).toBe(`Bearer ${state.tool_token}`);
    const tools = (config.vapi as Row).tools as Row[];
    expect(tools.map((t) => (t.function as Row).name)).toEqual(["check_availability", "book_appointment"]);
  });
});

describe("the webhook a finished call arrives on", () => {
  it("records a message call and makes its request — and a replay makes neither again", async () => {
    database();
    const state = await connect();
    const analysis = { name: "Bob Jones", phone: "540-555-0177", service: "Roof repair", message: "Please call me back about a roof leak." };
    const res = await webhook("call-1", analysis, state.webhook_secret as string);
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({
      company_id: CO, provider: "retell", provider_call_id: "call-1", caller_name: "Bob Jones", caller_phone: "+15405550163",
      called_number: "+15405550199", duration_seconds: 94, outcome: "message", client_id: "client-2",
    });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ company_id: CO, client_id: "client-2", intake_form_id: FORM, source: "phone", title: "Free roof inspection" });
    expect((requests()[0]!.answers as Row)).toMatchObject({ source: "voice_agent", message: "Please call me back about a roof leak.", service: "Roof repair" });
    expect(rpcs("booking_form_client")).toHaveLength(1);
    expect(rpcs("book_form_time")).toEqual([]);

    // The platform delivers the same report again (a retry, or call_ended after call_analyzed):
    // the row is updated in place and nothing is requested or booked twice.
    const replay = await webhook("call-1", analysis, state.webhook_secret as string);
    expect(replay.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(requests()).toHaveLength(1);
    expect(rpcs("booking_form_client")).toHaveLength(1);
  });

  it("books the time a caller asked for, on the voice form, and links the call to it", async () => {
    database();
    const state = await connect();
    const res = await webhook("call-2", { name: "Bob Jones", phone: "540-555-0177", service: "Roof replacement", starts_at: NINE, wants_booking: true }, state.webhook_secret as string);
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ outcome: "booked", client_id: "client-2", request_id: "request-2", visit_id: VISIT });
    expect(rpcs("book_form_time")).toHaveLength(1);
    expect(rpcs("book_form_time")[0]!.args).toMatchObject({ p_company: CO, p_form: FORM, p_name: "Bob Jones", p_phone: "540-555-0177", p_starts_at: NINE });
    expect((rpcs("book_form_time")[0]!.args.p_answers as Row)).toMatchObject({ source: "voice_agent", service: "Roof replacement" });
    expect(rpcs("call_off_visit_notice")).toEqual([{ fn: "call_off_visit_notice", args: { p_visit: VISIT } }]);
    // A booking makes its request inside book_form_time; the message path stays out of it.
    expect(requests()).toEqual([]);
    expect(rpcs("booking_form_client")).toEqual([]);
  });

  it("keeps a booking the calendar refused as a message request, so the lead isn't lost", async () => {
    database({ busy: [{ starts_at: NINE, ends_at: TEN }] });
    const state = await connect();
    const res = await webhook("call-3", { name: "Bob Jones", phone: "540-555-0177", service: "Roof replacement", starts_at: NINE, wants_booking: true }, state.webhook_secret as string);
    expect(res.status).toBe(200);
    expect(rpcs("book_form_time")).toEqual([]);
    expect(requests()).toHaveLength(1);
    expect((requests()[0]!.answers as Row)).toMatchObject({ source: "voice_agent", preferred_time: NINE });
    expect(calls()[0]).toMatchObject({ outcome: "message", client_id: "client-2" });
  });

  it("believes nothing with the wrong secret, or none: 403, and nothing written", async () => {
    database();
    await connect();
    const analysis = { name: "Bob Jones", phone: "540-555-0177", message: "Call me back." };
    expect((await webhook("call-4", analysis, "not-the-secret")).status).toBe(403);
    const bare = await post(`/webhooks/voice/${CO}/retell`, retellCall("call-4", analysis));
    expect(bare.status).toBe(403);
    expect(calls()).toEqual([]);
    expect(requests()).toEqual([]);
    expect(world.db.rpcs).toEqual([]);
  });

  it("records an FAQ-only call as just the call: no request, no booking", async () => {
    database();
    const state = await connect();
    const res = await webhook("call-5", { asked_faq: true }, state.webhook_secret as string);
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ outcome: "faq", client_id: null, request_id: null, visit_id: null });
    expect(requests()).toEqual([]);
    expect(world.db.rpcs).toEqual([]);
  });

  it("leaves events that aren't an end-of-call report unrecorded", async () => {
    database();
    const state = await connect();
    const res = await post(`/webhooks/voice/${CO}/retell`, { event: "call_started", call: { call_id: "call-6" } }, { "Content-Type": "application/json", "x-voice-secret": state.webhook_secret as string });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(calls()).toEqual([]);
  });
});

describe("the agent's tools, called mid-call", () => {
  const tool = (path: string, body: unknown, token?: string) =>
    post(path, body, token ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` } : { "Content-Type": "application/json" });

  it("turns away a missing or unknown token with 401", async () => {
    database();
    await connect();
    expect((await tool("/voice/tools/check-availability", { starts_at: NINE })).status).toBe(401);
    expect((await tool("/voice/tools/check-availability", { starts_at: NINE }, "some-other-token")).status).toBe(401);
    expect((await tool("/voice/tools/book-appointment", { name: "Bob Jones", phone: "540-555-0177", starts_at: NINE }, "some-other-token")).status).toBe(401);
    expect(rpcs("book_form_time")).toEqual([]);
  });

  it("answers availability for the day the caller asked about, with a spoken label on every slot", async () => {
    database();
    const state = await connect();
    const res = await tool("/voice/tools/check-availability", { starts_at: NINE, service: "Roof replacement" }, state.tool_token as string);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    expect(body.ok).toBe(true);
    expect(body.timezone).toBe(NY);
    const slots = body.slots as Row[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.map((s) => s.starts_at)).toContain(NINE);
    for (const slot of slots) {
      expect(String(slot.starts_at).startsWith("2026-11-03")).toBe(true);
      expect(typeof slot.label).toBe("string");
      expect((slot.label as string).length).toBeGreaterThan(0);
    }
  });

  it("books through the tool, and the end-of-call report merges onto the stub instead of doubling", async () => {
    database();
    const state = await connect();
    const token = state.tool_token as string;
    const booked = await tool("/voice/tools/book-appointment", {
      name: "Bob Jones", phone: "540-555-0177", address: "12 Main St", service: "Roof replacement", starts_at: TEN, provider_call_id: "call-live-1",
    }, token);
    expect(booked.status).toBe(200);
    expect(await booked.json()).toMatchObject({ ok: true, booked: true, request_id: "request-2", visit_id: VISIT, starts_at: TEN });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ provider_call_id: "call-live-1", outcome: "booked", client_id: "client-2", request_id: "request-2", visit_id: VISIT });

    // The call ends and its report arrives: same row, filled in — and no second booking.
    const res = await webhook("call-live-1", { name: "Bob Jones", phone: "540-555-0177", wants_booking: true, starts_at: TEN }, state.webhook_secret as string);
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ outcome: "booked", request_id: "request-2", visit_id: VISIT });
    expect(calls()[0]!.transcript).toContain("Thanks for calling Acme Roofing");
    expect(rpcs("book_form_time")).toHaveLength(1);
    expect(requests()).toEqual([]);
  });

  it("answers 409 when the time has just been taken", async () => {
    database({ busy: [{ starts_at: NINE, ends_at: TEN }] });
    const state = await connect();
    const res = await tool("/voice/tools/book-appointment", { name: "Bob Jones", phone: "540-555-0177", starts_at: NINE }, state.tool_token as string);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, reason: "taken" });
    expect(rpcs("book_form_time")).toEqual([]);
    expect(calls()).toEqual([]);
  });
});

describe("the AI command center's list", () => {
  it("lists the calls with their outcomes, and reads one back with its request's number", async () => {
    database();
    const state = await connect();
    await webhook("call-1", { name: "Bob Jones", phone: "540-555-0177", message: "Please call me back about a roof leak." }, state.webhook_secret as string);
    // The stored row gets the id the database would have given it, so it can be read back.
    const stored = calls()[0]!;
    stored.id = "00000000-0000-4000-8000-0000000000d1";
    world.db.tables.requests!.push({ id: "request-9", company_id: CO, number: 1043 });

    const list = await get("/voice/calls");
    expect(list.status).toBe(200);
    const body = (await list.json()) as Row;
    expect(body.total).toBe(1);
    expect((body.calls as Row[])[0]).toMatchObject({ id: stored.id, callerLabel: "Bob Jones", outcome: "message", outcomeLabel: "Left a message", booked: false, hasTranscript: true });

    const detail = await get(`/voice/calls/${stored.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()) as Row).toMatchObject({ provider_call_id: "call-1", outcome: "message" });
    expect((await get("/voice/calls/00000000-0000-4000-8000-0000000000d9")).status).toBe(404);
  });
});
