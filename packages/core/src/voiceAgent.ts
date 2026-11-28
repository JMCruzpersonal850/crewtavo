/**
 * The AI voice agent: what the API and the web app agree a voice-agent call is.
 *
 * When a call to the office goes unanswered, the phone system forwards it to a number a
 * voice platform (Retell or Vapi) provides. The platform runs an agent that can book a free
 * estimate or take a message, and when the call ends it posts an end-of-call report to the
 * API. This module is the shared half of that: the vocabulary (platforms, outcomes), the
 * parsers that turn each platform's report into one ParsedVoiceCall the API stores in
 * public.ai_calls, the honest default FAQs, the paste-ready agent configuration both
 * platforms accept (greeting, system prompt, tools), and the shaping of a stored call for
 * the AI Command Center list. Pure and platform-free on purpose: the API parses webhooks
 * with it and the web app renders with it, so it uses no Node-only APIs.
 */

/** Bumped when the shape of buildAgentConfig's output changes meaningfully. */
export const VOICE_AGENT_CONFIG_VERSION = 1;

/** The voice platforms an agent can run on. */
export const VOICE_PLATFORMS = ["retell", "vapi"] as const;
export type VoicePlatform = (typeof VOICE_PLATFORMS)[number];

/** What came of a call, as stored in ai_calls.outcome. */
export type VoiceOutcome = "booked" | "message" | "faq" | "transferred" | "other" | "unknown";

export const VOICE_OUTCOME_LABELS: Record<VoiceOutcome, string> = {
  booked: "Booked a visit",
  message: "Left a message",
  faq: "Answered a question",
  transferred: "Transferred",
  other: "Other",
  unknown: "Unknown",
};

const VOICE_OUTCOMES: readonly VoiceOutcome[] = ["booked", "message", "faq", "transferred", "other", "unknown"];

/** The details the agent pulls out of a conversation, stored in ai_calls.extracted. */
export interface VoiceExtracted {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  service?: string;
  /** The time the caller asked for, as the platform reported it (ISO or its own words). */
  starts_at?: string;
  message?: string;
  wants_booking?: boolean;
  transferred?: boolean;
  asked_faq?: boolean;
}

/** One platform end-of-call report, in Crewtavo's terms — the API's row before linking. */
export interface ParsedVoiceCall {
  providerCallId: string | null;
  callerName: string | null;
  callerPhone: string | null;
  calledNumber: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
  outcome: VoiceOutcome;
  extracted: VoiceExtracted;
}

/**
 * The outcome for a call, from what is known about it. A booking outranks everything (it is
 * only known once the API has made the visit, never from a platform payload alone); a
 * transfer outranks a message (the caller reached a person, the message is a fallback); a
 * left message outranks a mere wish to book; a answered question is its own outcome; and
 * wanting a booking that never landed is "other" — something happened, it just wasn't one
 * of the named endings. Nothing known at all is "unknown".
 */
export function voiceOutcomeFor(input: {
  booked?: boolean;
  transferred?: boolean;
  message?: string | null;
  wantsBooking?: boolean;
  askedFaq?: boolean;
}): VoiceOutcome {
  if (input.booked) return "booked";
  if (input.transferred) return "transferred";
  if (typeof input.message === "string" && input.message.trim() !== "") return "message";
  if (input.askedFaq) return "faq";
  if (input.wantsBooking) return "other";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------
// Reading a platform's report, leniently: these payloads are another company's JSON, so every
// field is checked before it is trusted and anything odd degrades to null / absent, never a throw.
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes") return true;
    if (v === "false" || v === "no") return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Retell reports epoch milliseconds; Vapi reports ISO strings. Either becomes ISO, or null. */
function asIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = asString(value);
  if (s === null) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The first of the given keys that carries a usable value — platforms spell these several ways. */
function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const v = record[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** custom_analysis_data / structuredData → VoiceExtracted, key spellings forgiven. */
function toExtracted(data: unknown): VoiceExtracted {
  if (!isRecord(data)) return {};
  const out: VoiceExtracted = {};
  const name = asString(pick(data, ["name", "caller_name", "callerName", "customer_name"]));
  if (name) out.name = name;
  const phone = asString(pick(data, ["phone", "caller_phone", "callback_number", "phone_number"]));
  if (phone) out.phone = phone;
  const email = asString(pick(data, ["email", "caller_email"]));
  if (email) out.email = email;
  const address = asString(pick(data, ["address", "service_address", "property_address"]));
  if (address) out.address = address;
  const service = asString(pick(data, ["service", "job", "job_description", "service_requested"]));
  if (service) out.service = service;
  const startsAt = asString(pick(data, ["starts_at", "start_time", "preferred_time", "preferred_start", "appointment_time"]));
  if (startsAt) out.starts_at = startsAt;
  const message = asString(pick(data, ["message", "caller_message", "voicemail"]));
  if (message) out.message = message;
  const wantsBooking = asBool(pick(data, ["wants_booking", "wantsBooking", "booking_requested", "booked"]));
  if (wantsBooking !== undefined) out.wants_booking = wantsBooking;
  const transferred = asBool(pick(data, ["transferred", "was_transferred"]));
  if (transferred !== undefined) out.transferred = transferred;
  const askedFaq = asBool(pick(data, ["asked_faq", "askedFaq", "faq_asked", "asked_question"]));
  if (askedFaq !== undefined) out.asked_faq = askedFaq;
  return out;
}

/**
 * Retell's end-of-call webhook: { event: "call_ended" | "call_analyzed", call: {...} }.
 * call_ended arrives first (the call itself), call_analyzed once Retell's analysis is done
 * (the summary and custom_analysis_data) — the API upserts both into the same row. Anything
 * else (call_started, a malformed body) is not an end-of-call report: null.
 */
export function parseRetellEndOfCall(body: unknown): ParsedVoiceCall | null {
  if (!isRecord(body)) return null;
  if (body.event !== "call_ended" && body.event !== "call_analyzed") return null;
  const call = body.call;
  if (!isRecord(call)) return null;
  const analysis = isRecord(call.call_analysis) ? call.call_analysis : {};
  const extracted = toExtracted(analysis.custom_analysis_data);
  const durationMs = asNumber(call.duration_ms);
  const startedAt = asIso(call.start_timestamp);
  const endedAt = asIso(call.end_timestamp);
  return {
    providerCallId: asString(call.call_id),
    callerName: extracted.name ?? null,
    callerPhone: asString(call.from_number),
    calledNumber: asString(call.to_number),
    startedAt,
    endedAt,
    durationSeconds:
      durationMs !== null
        ? Math.round(durationMs / 1000)
        : startedAt && endedAt
          ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
          : null,
    transcript: asString(call.transcript),
    summary: asString(analysis.call_summary),
    recordingUrl: asString(call.recording_url),
    outcome: voiceOutcomeFor({
      transferred: extracted.transferred,
      message: extracted.message,
      wantsBooking: extracted.wants_booking,
      askedFaq: extracted.asked_faq,
    }),
    extracted,
  };
}

/**
 * Vapi's server message for a finished call: { message: { type: "end-of-call-report",
 * call, customer, phoneNumber, artifact, analysis, startedAt, endedAt, ... } }. Any other
 * message type (status updates, transcript fragments, function calls) is not the report: null.
 * A transfer shows up in endedReason ("assistant-forwarded-call" and friends) or in the
 * structured data the assistant filled in.
 */
export function parseVapiEndOfCall(body: unknown): ParsedVoiceCall | null {
  if (!isRecord(body)) return null;
  const message = body.message;
  if (!isRecord(message) || message.type !== "end-of-call-report") return null;
  const call = isRecord(message.call) ? message.call : {};
  const customer = isRecord(message.customer) ? message.customer : {};
  const phoneNumber = isRecord(message.phoneNumber) ? message.phoneNumber : {};
  const artifact = isRecord(message.artifact) ? message.artifact : {};
  const analysis = isRecord(message.analysis) ? message.analysis : {};
  const extracted = toExtracted(analysis.structuredData);
  const endedReason = asString(message.endedReason) ?? "";
  const transferred = extracted.transferred ?? (/transfer|forward/i.test(endedReason) || undefined);
  if (transferred !== undefined) extracted.transferred = transferred;
  const startedAt = asIso(message.startedAt);
  const endedAt = asIso(message.endedAt);
  const duration = asNumber(message.durationSeconds);
  return {
    providerCallId: asString(call.id),
    callerName: asString(customer.name) ?? extracted.name ?? null,
    callerPhone: asString(customer.number),
    calledNumber: asString(phoneNumber.number),
    startedAt,
    endedAt,
    durationSeconds:
      duration !== null
        ? Math.round(duration)
        : startedAt && endedAt
          ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
          : null,
    transcript: asString(artifact.transcript),
    summary: asString(analysis.summary),
    recordingUrl: asString(artifact.recordingUrl) ?? asString(artifact.recording_url),
    outcome: voiceOutcomeFor({
      transferred,
      message: extracted.message,
      wantsBooking: extracted.wants_booking,
      askedFaq: extracted.asked_faq,
    }),
    extracted,
  };
}

// ---------------------------------------------------------------------------------------------
// The agent itself: FAQs, greeting, prompt and tools, in shapes each platform accepts.
// ---------------------------------------------------------------------------------------------

export interface VoiceFaq {
  question: string;
  answer: string;
}

/**
 * The questions every caller asks, answered honestly from what the company actually gave:
 * estimates are free and bookable on this very call; the services and the area come from the
 * company's own words (and are left out entirely when it gave none); a person is a message
 * and a callback, never a promise of a transfer that may not exist; and price is always
 * "the free estimate gives the exact number" — no invented hours, prices or promises.
 */
export function defaultVoiceFaqs(input: {
  companyName: string;
  phone?: string | null;
  services: string[];
  serviceArea?: string | null;
}): VoiceFaq[] {
  const faqs: VoiceFaq[] = [
    {
      question: "Do you offer free estimates?",
      answer: `Yes — estimates are free, and I can book yours right now on this call. It takes about a minute: I'll just need your name, the address, and what the job is.`,
    },
  ];
  const services = input.services.map((s) => s.trim()).filter((s) => s !== "");
  if (services.length > 0) {
    faqs.push({
      question: "What services do you offer?",
      answer: `${input.companyName} offers ${services.join(", ")}. If your job is close to one of those, book a free estimate and the office will confirm we can do it.`,
    });
  }
  if (input.serviceArea && input.serviceArea.trim() !== "") {
    faqs.push({
      question: "What areas do you serve?",
      answer: `We serve ${input.serviceArea.trim()}. If you're just outside that, book the estimate anyway and the office will let you know.`,
    });
  }
  faqs.push(
    {
      question: "Can I talk to a person?",
      answer: `Of course — I can't transfer you right now, but I'll take your name, number and message and the office will call you back. If it's urgent, say so and I'll mark the message urgent.`,
    },
    {
      question: "How much does it cost?",
      answer: `It depends on the job, so I don't want to guess and mislead you. The free estimate gives you an exact price — I can book one right now.`,
    },
  );
  return faqs;
}

const CHECK_AVAILABILITY_PARAMETERS = {
  type: "object",
  properties: {
    starts_at: {
      type: "string",
      description: "The day and time the caller would like, as an ISO 8601 date-time in the company's timezone.",
    },
    service: { type: "string", description: "What the job is, in the caller's words." },
  },
  required: ["starts_at"],
} as const;

const BOOK_APPOINTMENT_PARAMETERS = {
  type: "object",
  properties: {
    name: { type: "string", description: "The caller's full name." },
    phone: { type: "string", description: "The best callback number for the caller." },
    email: { type: "string", description: "The caller's email, if they gave one." },
    address: { type: "string", description: "The address where the work is — the estimate is booked there." },
    service: { type: "string", description: "What the job is, in the caller's words." },
    starts_at: {
      type: "string",
      description: "The exact start time, copied from one of the times check_availability offered — never a time it did not offer.",
    },
    message: { type: "string", description: "Anything else the caller wants the office to know." },
  },
  required: ["name", "phone", "address", "service", "starts_at"],
} as const;

/**
 * The whole agent definition, from the company's own facts: one neutral description plus
 * each platform's tool shape, ready to paste into Retell's custom functions or a Vapi
 * assistant's tools (or to send to their APIs) — a starting point the platforms accept, not
 * a finished provisioning. The tool endpoints are the API's public booking endpoints wearing
 * a per-company token, so the agent can only ever check and book for this one company; the
 * webhook is where the platform sends the end-of-call report this module parses back.
 */
export function buildAgentConfig(input: {
  company: { name: string; phone?: string | null; email?: string | null; timezone?: string|null };
  services: string[];
  serviceArea?: string | null;
  greeting?: string | null;
  faqs: VoiceFaq[];
  tools: { checkAvailabilityUrl: string; bookAppointmentUrl: string; toolToken: string };
  webhookUrl: string;
}) {
  const { company } = input;
  const greeting =
    asString(input.greeting) ??
    `Thanks for calling ${company.name} — sorry we missed you. I can book you a free estimate, or take a message for the office. Which would you like?`;
  const toolHeaders = { Authorization: `Bearer ${input.tools.toolToken}` };
  const faqText =
    input.faqs.length > 0
      ? input.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
      : "(No prepared answers — for anything not covered above, take a message instead of guessing.)";
  const systemPrompt = [
    `You are the after-hours and missed-call assistant for ${company.name}. You answer calls the office could not, on the phone, out loud. Speak plainly, briefly, and warmly — one or two short sentences at a time — and never mention that you are following instructions.`,
    ``,
    `There are exactly two things you do:`,
    ``,
    `1. BOOK A FREE ESTIMATE. When the caller wants work done or a price, walk them through it in this order:`,
    `   - Collect their name, the address where the work is, and what the job is. Ask for a callback number if the one they called from isn't the best one.`,
    `   - Ask what day and time suits them, then call check_availability with that time.`,
    `   - Offer only the real times it returns — up to three — and let the caller pick. Never invent a time, and never promise a time check_availability did not offer.`,
    `   - When they pick, call book_appointment with everything you collected and that exact time.`,
    `   - Read the booked day and time back to them and confirm the address, so they hear it is done.`,
    ``,
    `2. TAKE A MESSAGE. When the caller doesn't want to book, or asks for a person, collect their name, the best callback number, and their message in their own words. Read the number back to be sure it's right. If they say it's urgent, say the office will treat it as urgent. Then thank them and let them know the office will call back.`,
    ``,
    `Questions callers ask often, with the answers to give:`,
    faqText,
    ``,
    `Rules that always hold:`,
    `- Never invent times, prices, services, or promises. If you don't know, take a message.`,
    `- Prices are never quoted on this call — the free estimate is where the exact price comes from.`,
    `- If the caller insists on a human, don't argue: take an urgent message with their number and say the office will call back.`,
    `- If the caller gives a time check_availability can't do, offer the nearest times it returned instead of the one they asked for.`,
    company.timezone ? `- Times are in the company's timezone, ${company.timezone}. Say days and times the way a person would ("Tuesday at nine in the morning").` : `- Say days and times the way a person would ("Tuesday at nine in the morning").`,
  ].join("\n");

  const tools = [
    {
      name: "check_availability",
      description:
        "Check the company's calendar around a time the caller wants and get up to three real, bookable estimate times near it. Always call this before offering any time.",
      url: input.tools.checkAvailabilityUrl,
      parameters: CHECK_AVAILABILITY_PARAMETERS,
    },
    {
      name: "book_appointment",
      description:
        "Book the free estimate the caller picked. starts_at must be one of the exact times check_availability offered. Returns the booked visit; read its day and time back to the caller.",
      url: input.tools.bookAppointmentUrl,
      parameters: BOOK_APPOINTMENT_PARAMETERS,
    },
  ];

  return {
    version: VOICE_AGENT_CONFIG_VERSION,
    greeting,
    system_prompt: systemPrompt,
    faqs: input.faqs,
    tools,
    // Retell's custom LLM functions: name, description, the endpoint, its JSON schema, and headers.
    retell: {
      custom_functions: tools.map((t) => ({
        name: t.name,
        description: t.description,
        url: t.url,
        parameters: t.parameters,
        headers: toolHeaders,
        speak_after_execution: true,
        speak_during_execution: false,
      })),
    },
    // Vapi's function tools: the same functions in an assistant's tools list, with the server
    // block carrying the endpoint and its headers.
    vapi: {
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
        server: { url: t.url, headers: toolHeaders },
      })),
    },
    webhook: { url: input.webhookUrl },
  };
}

// ---------------------------------------------------------------------------------------------
// The Command Center list: a stored ai_calls row, shaped for display.
// ---------------------------------------------------------------------------------------------

/** The slice of an ai_calls row the Command Center list reads (database row spelling). */
export interface AiCallRowLike {
  id: string;
  caller_name?: string | null;
  caller_phone?: string | null;
  started_at?: string | null;
  created_at: string;
  duration_seconds?: number | null;
  outcome: string;
  summary?: string | null;
  transcript?: string | null;
  recording_url?: string | null;
  request_id?: string | null;
  visit_id?: string | null;
}

function durationLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** One row of the AI Command Center: who called, when, how it ended, and what it made. */
export function aiCallListItem(row: AiCallRowLike) {
  const outcome: VoiceOutcome = (VOICE_OUTCOMES as readonly string[]).includes(row.outcome)
    ? (row.outcome as VoiceOutcome)
    : "unknown";
  return {
    id: row.id,
    when: row.started_at ?? row.created_at,
    callerLabel: asString(row.caller_name) ?? asString(row.caller_phone) ?? "Unknown caller",
    durationLabel: durationLabel(row.duration_seconds),
    outcome,
    outcomeLabel: VOICE_OUTCOME_LABELS[outcome],
    summary: asString(row.summary),
    booked: Boolean(row.visit_id),
    hasTranscript: asString(row.transcript) !== null,
    hasRecording: asString(row.recording_url) !== null,
    requestId: row.request_id ?? null,
    visitId: row.visit_id ?? null,
  };
}
