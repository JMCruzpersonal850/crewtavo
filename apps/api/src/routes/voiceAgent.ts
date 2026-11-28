/**
 * AI Voice Agent: its Apps-page connection (Retell or Vapi answers the company's number when
 * nobody picks up), the calls it took (the AI command center's list), the webhook each finished
 * call arrives on, and the two tools the agent itself calls while it's talking — check what
 * times are open, and book one.
 *
 * Settings and secrets follow the Quo pattern (routes/apps.ts, lib/voiceAgent.ts): non-secret
 * settings in integrations, the platform key plus Crewtavo's own webhook secret and tool token
 * encrypted in integration_secrets. The webhook and the tools have no signed-in user: the
 * webhook is believed when it carries the webhook secret (or, for Retell, its signature over
 * the raw body keyed by the platform API key), and a tool call when its bearer token hashes to
 * the hash the company kept.
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { slotLabel } from "@crewtavo/core/slots";
import { arrivalWindowMin, localDate } from "@crewtavo/core/time";
import { aiCallListItem, buildAgentConfig, defaultVoiceFaqs, parseRetellEndOfCall, parseVapiEndOfCall, type ParsedVoiceCall } from "@crewtavo/core/voiceAgent";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { saveSecret, type StoredSecret } from "../integrations/tokens";
import { bearerToken, requireCompany, requireUser } from "../lib/auth";
import { kickAutomations } from "../lib/background";
import { hmacSha256Hex, keyedHash, randomId, safeEqual } from "../lib/crypto";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { companyIdForToolToken, loadVoiceSettings, voiceConfigured, voiceLive, voiceSettingsOf, webhookSecretMatches, type VoiceConnection, type VoiceSettings } from "../lib/voiceAgent";
import { bookFormTime, bookedVisitTitle, callOffBookedNotice, confirmBooking, formOpenings, BookingRefused } from "../services/onlineBooking";
import { companyRow, companyServices, recordVoiceCall, settleVoiceCall, voiceBookingForm, type AiCallRow } from "../services/voiceAgent";

export const voiceAgent = new Hono<AppEnv>();

const PROVIDER = "voice_agent" as const;

/** Where a platform sends a company's finished calls, per platform. */
const webhookUrl = (base: string, companyId: string, provider: string) => `${base}/api/webhooks/voice/${companyId}/${provider}`;
const toolUrls = (base: string) => ({
  check_availability: `${base}/api/voice/tools/check-availability`,
  book_appointment: `${base}/api/voice/tools/book-appointment`,
});

/** A short service-area line for the default FAQs: the company's own city/state when it has one. */
function serviceAreaOf(company: { address: unknown }): string {
  const a = (company?.address ?? {}) as Record<string, unknown>;
  return [a.city, a.state].filter((v) => typeof v === "string" && v).join(", ");
}

/** The FAQs the agent answers with: the company's own when it saved any, else the core defaults. */
async function faqsFor(admin: ReturnType<typeof adminClient>, companyId: string, settings: VoiceSettings) {
  if (settings.faqs.length) return settings.faqs;
  const company = await companyRow(admin, companyId);
  if (!company) return [];
  const services = await companyServices(admin, companyId);
  return defaultVoiceFaqs({ companyName: company.name, phone: company.phone ?? "", services, serviceArea: serviceAreaOf(company) });
}

/** The Apps-page state for the voice agent, secrets included only as far as an admin must paste them into the platform. */
async function voiceState(c: Context<AppEnv>, companyId: string, connection?: VoiceConnection | null) {
  const admin = adminClient(c.env);
  const loaded = connection === undefined ? await loadVoiceSettings(c.env, admin, companyId) : connection;
  const settings = loaded?.settings ?? voiceSettingsOf(null);
  const secret = loaded?.secret ?? null;
  const base = appUrl(c);
  return {
    connected: voiceConfigured(settings, secret),
    live: voiceLive(settings, secret) && loaded?.status !== "disconnected",
    platform: settings.platform,
    agent_id: settings.agent_id,
    phone_number: settings.phone_number,
    form_id: settings.form_id,
    enabled: settings.enabled,
    greeting: settings.greeting,
    faqs: await faqsFor(admin, companyId, settings),
    has_api_key: Boolean(secret?.api_key),
    // Our generated credentials, shown to admins because they paste them into the platform:
    // the tool token into the agent's tools, the webhook secret into its webhook.
    tool_token: secret?.extra?.tool_token ?? null,
    webhook_secret: secret?.extra?.webhook_secret ?? null,
    webhook_urls: { retell: webhookUrl(base, companyId, "retell"), vapi: webhookUrl(base, companyId, "vapi") },
    tool_urls: toolUrls(base),
  };
}

voiceAgent.get("/apps/voice", requireUser, requireCompany(ADMINS, "apps"), async (c) => c.json(await voiceState(c, c.var.companyId)));

const faqsBody = z.array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) })).max(20);

/**
 * Connect (or update) the voice agent: the platform, its API key (blank keeps the one kept),
 * the agent and number, the booking form, whether it's live, and what it says. Crewtavo's own
 * webhook secret and tool token are made here on first save and kept across saves, so a
 * platform already pointed at them keeps working.
 */
voiceAgent.put("/apps/voice/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(
    c,
    z.object({
      platform: z.enum(["retell", "vapi"]),
      api_key: z.string().trim().max(500).optional(),
      agent_id: z.string().trim().min(1).max(200),
      phone_number: z.string().trim().max(40),
      form_id: uuid.nullable().optional(),
      enabled: z.boolean(),
      greeting: z.string().trim().max(1000),
      faqs: faqsBody,
    }),
  );
  const admin = adminClient(c.env);
  const companyId = c.var.companyId;
  const existing = await loadVoiceSettings(c.env, admin, companyId).catch(() => null);
  const apiKey = body.api_key?.trim() || existing?.secret?.api_key || undefined;
  const webhookSecret = existing?.secret?.extra?.webhook_secret || randomId(24);
  const toolToken = existing?.secret?.extra?.tool_token || randomId(24);
  const settings: VoiceSettings = {
    platform: body.platform,
    agent_id: body.agent_id,
    phone_number: body.phone_number,
    form_id: body.form_id ?? null,
    enabled: body.enabled,
    greeting: body.greeting,
    faqs: body.faqs,
    tool_token_hash: await keyedHash(c.env, toolToken),
  };
  const { error } = await admin.from("integrations").upsert({
    company_id: companyId,
    provider: PROVIDER,
    status: apiKey ? "connected" : "disconnected",
    account_label: `${body.platform === "retell" ? "Retell" : "Vapi"} · ${body.phone_number || body.agent_id}`.slice(0, 200),
    external_account_id: body.agent_id,
    settings: asJson(settings),
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw dbError(error);
  const secret: StoredSecret = { ...(apiKey ? { api_key: apiKey } : {}), extra: { webhook_secret: webhookSecret, tool_token: toolToken } };
  await saveSecret(c.env, admin, companyId, PROVIDER, secret);
  return c.json(await voiceState(c, companyId, { settings, secret: secret as VoiceConnection["secret"], status: apiKey ? "connected" : "disconnected" }));
});

/** A fresh webhook secret or tool token: the old one stops working wherever it was pasted. */
voiceAgent.post("/apps/voice/regenerate", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ which: z.enum(["tool_token", "webhook_secret"]) }));
  const admin = adminClient(c.env);
  const companyId = c.var.companyId;
  const existing = await loadVoiceSettings(c.env, admin, companyId);
  if (!existing?.secret) throw new HttpError(400, "Save the voice agent settings first, then you can replace its secrets.");
  const fresh = randomId(24);
  const secret: StoredSecret = {
    ...(existing.secret.api_key ? { api_key: existing.secret.api_key } : {}),
    extra: {
      webhook_secret: body.which === "webhook_secret" ? fresh : existing.secret.extra?.webhook_secret ?? "",
      tool_token: body.which === "tool_token" ? fresh : existing.secret.extra?.tool_token ?? "",
    },
  };
  await saveSecret(c.env, admin, companyId, PROVIDER, secret);
  let settings = existing.settings;
  if (body.which === "tool_token") {
    settings = { ...settings, tool_token_hash: await keyedHash(c.env, fresh) };
    const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).match({ company_id: companyId, provider: PROVIDER });
    if (error) throw dbError(error);
  }
  return c.json(await voiceState(c, companyId, { settings, secret: secret as VoiceConnection["secret"], status: existing.status }));
});

/** Disconnect: the agent stops, and Crewtavo forgets the platform key and both of its own secrets. */
voiceAgent.delete("/apps/voice/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const admin = adminClient(c.env);
  const companyId = c.var.companyId;
  const existing = await loadVoiceSettings(c.env, admin, companyId).catch(() => null);
  if (existing) {
    const { error } = await admin
      .from("integrations")
      .update({ status: "disconnected", account_label: null, last_error: null, settings: asJson({ ...existing.settings, enabled: false }) })
      .match({ company_id: companyId, provider: PROVIDER });
    if (error) throw dbError(error);
  }
  await admin.from("integration_secrets").delete().match({ company_id: companyId, provider: PROVIDER });
  return c.json(await voiceState(c, companyId, null));
});

/**
 * Everything the platform's agent is set up with — its instructions, greeting, FAQs and tools —
 * as one JSON the admin pastes (or a setup script sends) into Retell/Vapi. Needs the saved
 * settings first: the tool token in it is made when they're saved.
 */
voiceAgent.get("/apps/voice/agent-config", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const admin = adminClient(c.env);
  const companyId = c.var.companyId;
  const connection = await loadVoiceSettings(c.env, admin, companyId);
  const toolToken = connection?.secret?.extra?.tool_token;
  if (!connection || !toolToken) throw new HttpError(400, "Save the voice agent settings first, so Crewtavo can make the tool token the agent uses, then get the agent config again.");
  const company = await companyRow(admin, companyId);
  if (!company) throw new HttpError(404, "Company not found.");
  const services = await companyServices(admin, companyId);
  const base = appUrl(c);
  const config = buildAgentConfig({
    company: { name: company.name, phone: company.phone ?? "", email: company.email ?? "", timezone: company.timezone ?? "UTC" },
    services,
    serviceArea: serviceAreaOf(company),
    greeting: connection.settings.greeting,
    faqs: await faqsFor(admin, companyId, connection.settings),
    tools: { checkAvailabilityUrl: toolUrls(base).check_availability, bookAppointmentUrl: toolUrls(base).book_appointment, toolToken },
    webhookUrl: webhookUrl(base, companyId, connection.settings.platform ?? "retell"),
  });
  return c.json(config as Record<string, unknown>);
});

// ---------------------------------------------------------------------------------------------
// The calls the agent took (the AI command center)
// ---------------------------------------------------------------------------------------------

voiceAgent.get("/voice/calls", requireUser, requireCompany(OFFICE), async (c) => {
  const outcome = c.req.query("outcome") || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  let query = c.var.db.from("ai_calls").select("*").eq("company_id", c.var.companyId).order("started_at", { ascending: false }).limit(1000);
  if (outcome) query = query.eq("outcome", outcome);
  const { data, error } = await query;
  if (error) throw dbError(error);
  const rows = (data ?? []) as unknown as AiCallRow[];
  return c.json({ calls: rows.slice(offset, offset + limit).map((row) => aiCallListItem(row as never)), total: rows.length });
});

voiceAgent.get("/voice/calls/:id", requireUser, requireCompany(OFFICE), async (c) => {
  const id = param(c, "id");
  const row = must(await c.var.db.from("ai_calls").select("*").eq("company_id", c.var.companyId).eq("id", id).maybeSingle(), "Call not found.") as unknown as AiCallRow;
  let requestNumber: number | null = null;
  let visitStartsAt: string | null = null;
  if (row.request_id) {
    const { data } = await c.var.db.from("requests").select("number").eq("company_id", c.var.companyId).eq("id", row.request_id).maybeSingle();
    requestNumber = (data as { number?: number } | null)?.number ?? null;
  }
  if (row.visit_id) {
    const { data } = await c.var.db.from("visits").select("starts_at").eq("company_id", c.var.companyId).eq("id", row.visit_id).maybeSingle();
    visitStartsAt = (data as { starts_at?: string } | null)?.starts_at ?? null;
  }
  return c.json({ ...row, request_number: requestNumber, visit_starts_at: visitStartsAt });
});

// ---------------------------------------------------------------------------------------------
// The webhook: a finished call arrives
// ---------------------------------------------------------------------------------------------

voiceAgent.post("/webhooks/voice/:companyId/:provider", async (c) => {
  const companyId = c.req.param("companyId");
  const provider = c.req.param("provider");
  if (!companyId || !uuid.safeParse(companyId).success || (provider !== "retell" && provider !== "vapi")) throw new HttpError(404, "Not found.");
  const raw = await c.req.text();
  const admin = adminClient(c.env);
  const connection = await loadVoiceSettings(c.env, admin, companyId).catch(() => null);
  if (!connection || connection.status === "disconnected" || !voiceConfigured(connection.settings, connection.secret)) {
    return c.json({ error: "The voice agent isn't connected for that company." }, 404);
  }
  // Believed when it carries the webhook secret (a header either platform can send, or the
  // query on the webhook address), or — Retell only — when its signature over the raw body,
  // keyed by the platform API key we keep, matches.
  const provided = c.req.header("x-voice-secret") ?? c.req.header("x-vapi-secret") ?? c.req.query("secret") ?? null;
  let verified = webhookSecretMatches(connection.secret, provided);
  if (!verified && provider === "retell" && connection.secret?.api_key) {
    const signature = (c.req.header("x-retell-signature") ?? "").replace(/^sha256=/, "");
    if (signature) verified = safeEqual(await hmacSha256Hex(connection.secret.api_key, raw), signature.toLowerCase());
  }
  if (!verified) throw new HttpError(403, "Bad signature.");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Not JSON.");
  }
  const parsed = provider === "retell" ? parseRetellEndOfCall(payload) : parseVapiEndOfCall(payload);
  if (!parsed) return c.json({ ok: true, ignored: true });
  const { row, created } = await recordVoiceCall(c.env, admin, companyId, provider, parsed, payload);
  if (created) {
    const settled = await settleVoiceCall(c.env, admin, companyId, row, parsed, appUrl(c));
    if (settled.request_id) kickAutomations(c, companyId);
    return c.json({ ok: true, call_id: settled.id });
  }
  return c.json({ ok: true, call_id: row.id });
});

// ---------------------------------------------------------------------------------------------
// The agent's tools, called mid-call with its tool token
// ---------------------------------------------------------------------------------------------

async function toolCompany(c: Context<AppEnv>): Promise<{ admin: ReturnType<typeof adminClient>; companyId: string }> {
  const token = bearerToken(c.req.header("authorization"));
  const admin = adminClient(c.env);
  const companyId = token ? await companyIdForToolToken(c.env, admin, token).catch(() => null) : null;
  if (!companyId) throw new HttpError(401, "Unauthorized");
  return { admin, companyId };
}

voiceAgent.post("/voice/tools/check-availability", async (c) => {
  const { admin, companyId } = await toolCompany(c);
  const body = (await c.req.json().catch(() => ({}))) as { starts_at?: unknown; from?: unknown; days?: unknown };
  const connection = await loadVoiceSettings(c.env, admin, companyId).catch(() => null);
  const company = await companyRow(admin, companyId);
  const form = company ? await voiceBookingForm(admin, companyId, connection?.settings) : null;
  if (!company || !form) return c.json({ ok: false, reason: "no_booking_form", slots: [] });
  // The agent asks the way buildAgentConfig's tool schema teaches it: a starts_at it wants
  // checked. That day, in the company's own zone, is the day whose openings answer; an explicit
  // from/days (a person testing the endpoint) still wins.
  const wanted = typeof body.starts_at === "string" && Number.isFinite(Date.parse(body.starts_at)) ? new Date(body.starts_at) : null;
  const from =
    typeof body.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : wanted ? localDate(wanted, company.timezone || "UTC") : undefined;
  const days =
    typeof body.days === "number" && Number.isFinite(body.days) ? Math.min(Math.max(Math.round(body.days), 1), 14) : wanted && !body.from ? 1 : undefined;
  const openings = await formOpenings(admin, company, form, { ...(from ? { from } : {}), ...(days ? { days } : {}) });
  const tz = company.timezone || "UTC";
  const window = arrivalWindowMin(company.settings);
  return c.json({
    ok: true,
    timezone: tz,
    slots: openings.slots
      .filter((s) => s.starts_at && s.ends_at)
      .map((s) => ({ starts_at: s.starts_at, ends_at: s.ends_at, label: slotLabel({ date: s.date, starts_at: s.starts_at }, tz, window) })),
  });
});

voiceAgent.post("/voice/tools/book-appointment", async (c) => {
  const { admin, companyId } = await toolCompany(c);
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      phone: z.string().trim().min(1).max(40),
      email: z.string().trim().max(200).optional(),
      address: z.union([z.string().max(500), z.record(z.string(), z.unknown())]).optional(),
      starts_at: z.string().min(1).max(60),
      service: z.string().trim().max(200).optional(),
      provider_call_id: z.string().trim().max(200).optional(),
    }),
  );
  if (!Number.isFinite(Date.parse(body.starts_at))) throw new HttpError(400, "That start time doesn't look right.");
  const connection = await loadVoiceSettings(c.env, admin, companyId).catch(() => null);
  const company = await companyRow(admin, companyId);
  const form = company ? await voiceBookingForm(admin, companyId, connection?.settings) : null;
  if (!company || !form) throw new HttpError(400, "This company has no booking form that lets clients pick a time.");
  const address = typeof body.address === "string" ? { line1: body.address } : body.address ?? {};
  let made;
  try {
    made = await bookFormTime(admin, company, form, {
      name: body.name, ...(body.email ? { email: body.email } : {}), phone: body.phone, address,
      answers: { source: "voice_agent", service: body.service ?? null }, starts_at: body.starts_at, promo: null, web_visit: null,
    });
  } catch (error) {
    if (error instanceof BookingRefused) return c.json({ ok: false, reason: "taken", message: error.message }, 409);
    throw error;
  }
  await confirmBooking(c.env, admin, { companyId, clientId: made.client_id, requestId: made.request_id, visitId: made.visit_id, title: bookedVisitTitle(form), startsAt: made.starts_at, booked: made.booked, text: true }, appUrl(c));
  if (made.visit_id) await callOffBookedNotice(admin, made.visit_id);
  if (body.provider_call_id) {
    // A stub for the call in progress, so the end-of-call webhook that follows merges onto it
    // (recordVoiceCall) instead of recording the booking twice.
    const platform = connection?.settings.platform ?? "retell";
    const parsed: ParsedVoiceCall = {
      providerCallId: body.provider_call_id, callerName: body.name, callerPhone: body.phone, calledNumber: connection?.settings.phone_number ?? "",
      startedAt: new Date().toISOString(), endedAt: null, durationSeconds: null, transcript: "", summary: "", recordingUrl: null, outcome: "booked",
      extracted: { name: body.name, phone: body.phone, email: body.email ?? null, address: typeof body.address === "string" ? body.address : null, service: body.service ?? null, starts_at: made.starts_at, message: null, wants_booking: true, transferred: false, asked_faq: false },
    } as unknown as ParsedVoiceCall;
    const { row } = await recordVoiceCall(c.env, admin, companyId, platform, parsed, { tool: "book-appointment" });
    if (!row.request_id) {
      await admin.from("ai_calls").update({ client_id: made.client_id, request_id: made.request_id, visit_id: made.visit_id, outcome: "booked" }).eq("id", row.id);
    }
  }
  return c.json({ ok: true, booked: made.booked, request_id: made.request_id, visit_id: made.visit_id, starts_at: made.starts_at, ends_at: made.ends_at });
});
