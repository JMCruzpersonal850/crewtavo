/**
 * What a finished AI voice call becomes: a row in ai_calls, and — for a fresh call, once — the
 * booking or the request the caller asked for, made through the same online-booking machinery a
 * booking form uses (services/onlineBooking.ts), so a voice booking checks the same openings,
 * tells the client the same way, and lands in the same places.
 *
 * requests.source has no "voice_agent" value: its check constraint (supabase/migrations
 * 20261016000200_operations.sql, widened in 20261017000300_marketing.sql) allows 'manual',
 * 'phone', 'web_form', 'hub', 'email', 'assistant' and 'referral'. A voice call is a phone call,
 * so requests it makes carry source 'phone', and answers.source = 'voice_agent' keeps the exact
 * origin on the request itself.
 */
import { getPreset } from "@crewtavo/core";
import type { ParsedVoiceCall } from "@crewtavo/core/voiceAgent";
import type { Env } from "../env";
import { asJson, dbError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { loadVoiceSettings, type VoiceSettings } from "../lib/voiceAgent";
import { BOOKING_FORM_FIELDS, bookFormTime, bookedVisitTitle, callOffBookedNotice, confirmBooking, BookingRefused, type BookingCompany, type BookingForm } from "./onlineBooking";

export interface VoiceCompany extends BookingCompany {
  email: string | null;
  address: unknown;
  trade_preset: string | null;
}

/** The company a voice call belongs to, with what the agent config and FAQs are built from. */
export async function companyRow(admin: Db, companyId: string): Promise<VoiceCompany | null> {
  const { data, error } = await admin.from("companies").select("id, name, phone, email, timezone, settings, address, trade_preset").eq("id", companyId).maybeSingle();
  if (error) throw dbError(error);
  return (data as VoiceCompany | null) ?? null;
}

/**
 * The form a voice booking goes through: the one picked in the voice settings when it's still
 * there and still lets clients pick a time, else the company's first active pick-a-time form.
 * intake_forms has no archived column; `active` is its off switch, and it's respected here.
 */
export async function voiceBookingForm(admin: Db, companyId: string, settings: VoiceSettings | null | undefined): Promise<BookingForm | null> {
  const fields = `${BOOKING_FORM_FIELDS}, active`;
  if (settings?.form_id) {
    const { data, error } = await admin.from("intake_forms").select(fields).eq("company_id", companyId).eq("id", settings.form_id).maybeSingle();
    if (error) throw dbError(error);
    const form = data as (BookingForm & { active?: boolean }) | null;
    if (form && form.pick_time && form.active !== false) return form;
  }
  const { data, error } = await admin.from("intake_forms").select(fields).eq("company_id", companyId).eq("pick_time", true).order("created_at", { ascending: true }).limit(50);
  if (error) throw dbError(error);
  const form = ((data ?? []) as Array<BookingForm & { active?: boolean }>).find((f) => f.active !== false);
  return form ?? null;
}

/**
 * The company's sellable service names, for the agent's FAQs and config: its price book
 * (public.services, the same rows quotes are built from), active ones in price-book order.
 * A company whose price book is still empty falls back to its trade preset's services
 * (packages/core presets, via getPreset on companies.trade_preset) — the catalog it started
 * from — so the agent can still name what the business does.
 */
export async function companyServices(admin: Db, companyId: string): Promise<string[]> {
  const { data, error } = await admin.from("services").select("name").eq("company_id", companyId).eq("active", true).order("sort", { ascending: true }).limit(200);
  if (error) throw dbError(error);
  const names = (data ?? []).map((s) => s.name).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  if (names.length) return names;
  const company = await companyRow(admin, companyId).catch(() => null);
  try {
    return getPreset(company?.trade_preset || "general").services.map((s) => s.name);
  } catch {
    return [];
  }
}

/** An ai_calls row as stored. */
export interface AiCallRow {
  id: string;
  company_id: string;
  provider: string;
  provider_call_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  called_number: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: string;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  extracted: unknown;
  client_id: string | null;
  request_id: string | null;
  visit_id: string | null;
  [key: string]: unknown;
}

const callFields = (companyId: string, provider: string, parsed: ParsedVoiceCall, raw: unknown) => ({
  company_id: companyId,
  provider,
  provider_call_id: parsed.providerCallId || null,
  caller_name: parsed.callerName || null,
  caller_phone: parsed.callerPhone || null,
  called_number: parsed.calledNumber || null,
  started_at: parsed.startedAt || null,
  ended_at: parsed.endedAt || null,
  duration_seconds: parsed.durationSeconds ?? null,
  outcome: parsed.outcome || "unknown",
  summary: parsed.summary || null,
  transcript: parsed.transcript || null,
  recording_url: parsed.recordingUrl || null,
  extracted: asJson(parsed.extracted ?? {}),
  raw: asJson(raw ?? {}),
  client_id: null as string | null,
  request_id: null as string | null,
  visit_id: null as string | null,
});

/**
 * Records a finished call, once per (company, provider, provider call id): a platform retrying
 * its webhook gets the row it already made back with created=false, so the caller skips
 * post-processing and nothing is booked or requested twice. A row that's already there (a retry,
 * or the stub the book-appointment tool made while the call was live) is updated with the call's
 * own fields, but its client/request/visit links are never nulled out. A call with no provider
 * id can't be told apart from another, so it's simply inserted.
 */
export async function recordVoiceCall(env: Env, admin: Db, companyId: string, provider: string, parsed: ParsedVoiceCall, raw: unknown): Promise<{ row: AiCallRow; created: boolean }> {
  void env;
  const fields = callFields(companyId, provider, parsed, raw);
  if (parsed.providerCallId) {
    const found = await admin.from("ai_calls").select("*").eq("company_id", companyId).eq("provider", provider).eq("provider_call_id", parsed.providerCallId).maybeSingle();
    if (found.error) throw dbError(found.error);
    if (found.data) {
      const existing = found.data as unknown as AiCallRow;
      // A row the book-appointment tool already booked keeps its outcome: the end-of-call
      // report only knows the caller wanted a booking, not that it landed.
      const outcome = existing.outcome === "booked" ? "booked" : fields.outcome;
      const { data, error } = await admin
        .from("ai_calls")
        .update({ ...fields, outcome, client_id: existing.client_id ?? null, request_id: existing.request_id ?? null, visit_id: existing.visit_id ?? null, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (error) throw dbError(error);
      return { row: data as unknown as AiCallRow, created: false };
    }
    const { data, error } = await admin.from("ai_calls").upsert(fields, { onConflict: "company_id,provider,provider_call_id" }).select("*").single();
    if (error) throw dbError(error);
    return { row: data as unknown as AiCallRow, created: true };
  }
  const { data, error } = await admin.from("ai_calls").insert(fields).select("*").single();
  if (error) throw dbError(error);
  return { row: data as unknown as AiCallRow, created: true };
}

async function linkCall(admin: Db, row: AiCallRow, patch: Partial<Pick<AiCallRow, "client_id" | "request_id" | "visit_id" | "outcome">>): Promise<AiCallRow> {
  const { data, error } = await admin.from("ai_calls").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
  if (error) throw dbError(error);
  return data as unknown as AiCallRow;
}

/** An extracted address as book_form_time takes it: a string is its first line. */
const addressOf = (address: unknown): unknown => {
  if (!address) return {};
  if (typeof address === "string") return { line1: address };
  if (typeof address === "object") {
    const a = address as Record<string, unknown>;
    return typeof a.line1 === "string" ? a : { line1: String(a.line1 ?? a.address ?? "") };
  }
  return {};
};

/**
 * Post-processing for a fresh call row, in order:
 * (a) the caller gave a name, a phone and a time that parses — book it on the voice form, the
 *     way a client booking their own time is booked, and tell them;
 * (b) else, a message was left (or the call's outcome is a message) and we have a name or a
 *     phone — a request the way public.ts's no-time form path makes one (booking_form_client,
 *     then the requests insert), titled from the form or as a message from the agent;
 * (c) neither — the call record alone is the outcome (an FAQ answered, a hang-up).
 * A time the form refuses (BookingRefused) falls through to the message path, so the lead isn't
 * lost. Nothing here throws: the webhook has a call to acknowledge either way, and a settle
 * failure is logged with the call record kept.
 */
export async function settleVoiceCall(env: Env, admin: Db, companyId: string, row: AiCallRow, parsed: ParsedVoiceCall, baseUrl: string | null): Promise<AiCallRow> {
  try {
    const company = await companyRow(admin, companyId);
    if (!company) return row;
    const connection = await loadVoiceSettings(env, admin, companyId).catch(() => null);
    const form = await voiceBookingForm(admin, companyId, connection?.settings);
    const ex = parsed.extracted ?? ({} as ParsedVoiceCall["extracted"]);
    const name = ex.name || parsed.callerName || "";
    const phone = ex.phone || parsed.callerPhone || "";
    const startsAt = ex.starts_at && Number.isFinite(Date.parse(ex.starts_at)) ? ex.starts_at : null;

    let refused = false;
    if (form && name && phone && startsAt) {
      try {
        const made = await bookFormTime(admin, company, form, {
          name,
          ...(ex.email ? { email: ex.email } : {}),
          phone,
          address: addressOf(ex.address),
          answers: { source: "voice_agent", service: ex.service ?? null },
          starts_at: startsAt,
          promo: null,
          web_visit: null,
        });
        const linked = await linkCall(admin, row, { client_id: made.client_id, request_id: made.request_id, visit_id: made.visit_id, outcome: "booked" });
        await confirmBooking(env, admin, { companyId, clientId: made.client_id, requestId: made.request_id, visitId: made.visit_id, title: bookedVisitTitle(form), startsAt: made.starts_at, booked: made.booked, text: true }, baseUrl);
        if (made.visit_id) await callOffBookedNotice(admin, made.visit_id);
        return linked;
      } catch (error) {
        if (!(error instanceof BookingRefused)) throw error;
        refused = true;
        console.warn("A voice call's time was refused; keeping it as a message instead", row.id, error.message);
      }
    }

    if ((refused || ex.message || parsed.outcome === "message") && (name || phone)) {
      const found = await admin.rpc("booking_form_client", {
        p_company: companyId, p_name: name || "Voice caller", p_email: (ex.email ?? null) as string, p_phone: (phone || null) as string, p_address: asJson(addressOf(ex.address)),
      });
      if (found.error) throw dbError(found.error);
      const client = found.data as unknown as { client_id: string; property_id: string | null } | null;
      if (!client) return row;
      const { data: request, error } = await admin
        .from("requests")
        .insert({
          company_id: companyId, client_id: client.client_id, property_id: client.property_id, intake_form_id: form?.id ?? null,
          // 'phone', not 'voice_agent': the requests.source check doesn't allow the latter (see the header).
          source: "phone",
          title: form?.name ?? "Message from AI voice agent",
          answers: asJson({ source: "voice_agent", message: ex.message ?? null, service: ex.service ?? null, preferred_time: startsAt, transcript_summary: parsed.summary ?? null }),
          created_by: null,
        })
        .select("id")
        .single();
      if (error) throw dbError(error);
      return await linkCall(admin, row, { client_id: client.client_id, request_id: request.id, outcome: refused ? "message" : parsed.outcome ?? "message" });
    }
    return row;
  } catch (error) {
    console.error("A voice call couldn't be settled", row.id, error);
    return row;
  }
}
