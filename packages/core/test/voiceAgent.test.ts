import { describe, expect, it } from "vitest";
import {
  VOICE_AGENT_CONFIG_VERSION,
  VOICE_OUTCOME_LABELS,
  VOICE_PLATFORMS,
  aiCallListItem,
  buildAgentConfig,
  defaultVoiceFaqs,
  parseRetellEndOfCall,
  parseVapiEndOfCall,
  voiceOutcomeFor,
} from "../src/voiceAgent";

/**
 * The voice agent's shared half: each platform's end-of-call report parsed into one shape,
 * the outcome picked by priority, the honest default FAQs, the paste-ready agent config,
 * and a stored call shaped for the AI Command Center list. The API's webhook tests lean on
 * the same fixtures' shapes.
 */

const RETELL_ANALYZED = {
  event: "call_analyzed",
  call: {
    call_id: "call_abc123",
    agent_id: "agent_1",
    from_number: "+18505550101",
    to_number: "+18505550199",
    start_timestamp: 1764352800000,
    end_timestamp: 1764352980000,
    duration_ms: 180000,
    transcript: "Agent: Thanks for calling Ocean Crest Painting — sorry we missed you...",
    recording_url: "https://retell.example/recordings/call_abc123.wav",
    call_analysis: {
      call_summary: "Caller asked for a callback about painting his brick exterior.",
      custom_analysis_data: {
        caller_name: "Geoff Larue",
        phone: "+18505550101",
        address: "504 Silverthorn Rd",
        service: "Exterior brick painting",
        message: "Please call me back about the brick job.",
        wants_booking: false,
      },
    },
  },
};

const VAPI_REPORT = {
  message: {
    type: "end-of-call-report",
    call: { id: "vapi-call-1" },
    customer: { number: "+18505550102", name: "Karen Clem" },
    phoneNumber: { number: "+18505550199" },
    artifact: {
      transcript: "Assistant: Thanks for calling JC Landscaping...",
      recordingUrl: "https://vapi.example/recordings/vapi-call-1.wav",
    },
    analysis: {
      summary: "Caller wants a fence estimate and left her details.",
      structuredData: {
        name: "Karen Clem",
        address: "12 Oak St",
        service: "Fence installation",
        wants_booking: true,
        message: "Wants a fence estimate this week.",
      },
    },
    startedAt: "2026-11-27T14:00:00.000Z",
    endedAt: "2026-11-27T14:03:20.000Z",
    durationSeconds: 200,
    endedReason: "customer-ended-call",
  },
};

describe("voiceOutcomeFor", () => {
  it("ranks booked over transferred over message over faq over a booking wish", () => {
    expect(voiceOutcomeFor({ booked: true, transferred: true, message: "hi", askedFaq: true, wantsBooking: true })).toBe("booked");
    expect(voiceOutcomeFor({ transferred: true, message: "hi", askedFaq: true })).toBe("transferred");
    expect(voiceOutcomeFor({ message: "call me back", askedFaq: true, wantsBooking: true })).toBe("message");
    expect(voiceOutcomeFor({ message: "  ", askedFaq: true })).toBe("faq");
    expect(voiceOutcomeFor({ wantsBooking: true })).toBe("other");
    expect(voiceOutcomeFor({})).toBe("unknown");
    expect(voiceOutcomeFor({ message: null })).toBe("unknown");
  });
});

describe("parseRetellEndOfCall", () => {
  it("reads a call_analyzed report, custom analysis and all", () => {
    const parsed = parseRetellEndOfCall(RETELL_ANALYZED);
    expect(parsed).not.toBeNull();
    expect(parsed!.providerCallId).toBe("call_abc123");
    expect(parsed!.callerName).toBe("Geoff Larue");
    expect(parsed!.callerPhone).toBe("+18505550101");
    expect(parsed!.calledNumber).toBe("+18505550199");
    expect(parsed!.startedAt).toBe(new Date(1764352800000).toISOString());
    expect(parsed!.endedAt).toBe(new Date(1764352980000).toISOString());
    expect(parsed!.durationSeconds).toBe(180);
    expect(parsed!.summary).toContain("callback");
    expect(parsed!.recordingUrl).toContain("call_abc123");
    expect(parsed!.extracted).toMatchObject({
      name: "Geoff Larue",
      address: "504 Silverthorn Rd",
      service: "Exterior brick painting",
      message: "Please call me back about the brick job.",
      wants_booking: false,
    });
    // A left message is the outcome; a booking is only ever set later, by the API.
    expect(parsed!.outcome).toBe("message");
  });

  it("reads a bare call_ended report (no analysis yet)", () => {
    const parsed = parseRetellEndOfCall({
      event: "call_ended",
      call: { call_id: "call_x", from_number: "+1", to_number: "+2", start_timestamp: 1000, end_timestamp: 61000 },
    });
    expect(parsed!.durationSeconds).toBe(60);
    expect(parsed!.outcome).toBe("unknown");
    expect(parsed!.extracted).toEqual({});
  });

  it("returns null for other events and malformed bodies", () => {
    expect(parseRetellEndOfCall({ event: "call_started", call: { call_id: "c" } })).toBeNull();
    expect(parseRetellEndOfCall({ event: "call_ended" })).toBeNull();
    expect(parseRetellEndOfCall(null)).toBeNull();
    expect(parseRetellEndOfCall("call_ended")).toBeNull();
  });
});

describe("parseVapiEndOfCall", () => {
  it("reads an end-of-call report, structured data and all", () => {
    const parsed = parseVapiEndOfCall(VAPI_REPORT);
    expect(parsed).not.toBeNull();
    expect(parsed!.providerCallId).toBe("vapi-call-1");
    expect(parsed!.callerName).toBe("Karen Clem");
    expect(parsed!.callerPhone).toBe("+18505550102");
    expect(parsed!.calledNumber).toBe("+18505550199");
    expect(parsed!.startedAt).toBe("2026-11-27T14:00:00.000Z");
    expect(parsed!.durationSeconds).toBe(200);
    expect(parsed!.extracted).toMatchObject({ service: "Fence installation", wants_booking: true });
    expect(parsed!.outcome).toBe("message");
  });

  it("calls a forwarded call transferred, whatever else it carried", () => {
    const parsed = parseVapiEndOfCall({
      message: { ...VAPI_REPORT.message, endedReason: "assistant-forwarded-call" },
    });
    expect(parsed!.outcome).toBe("transferred");
    expect(parsed!.extracted.transferred).toBe(true);
  });

  it("returns null for other message types", () => {
    expect(parseVapiEndOfCall({ message: { type: "status-update", call: { id: "c" } } })).toBeNull();
    expect(parseVapiEndOfCall({})).toBeNull();
    expect(parseVapiEndOfCall(null)).toBeNull();
  });
});

describe("defaultVoiceFaqs", () => {
  it("answers honestly: free estimates, the given services and area, a person means a callback, price means the estimate", () => {
    const faqs = defaultVoiceFaqs({
      companyName: "Ocean Crest Painting",
      services: ["Interior painting", "Exterior painting"],
      serviceArea: "Pensacola and Gulf Breeze",
    });
    const text = faqs.map((f) => `${f.question} ${f.answer}`).join("\n");
    expect(text).toContain("free");
    expect(text).toContain("Interior painting");
    expect(text).toContain("Pensacola and Gulf Breeze");
    expect(text).toContain("call you back");
    // Nothing invented: no hours, no prices, no dollar figures anywhere.
    expect(text).not.toMatch(/\$\d|per hour|open (from|until)|hours are/i);
  });

  it("leaves the service area (and an empty service list) out entirely when not given", () => {
    const faqs = defaultVoiceFaqs({ companyName: "JC Landscaping", services: [] });
    expect(faqs.some((f) => /areas do you serve/i.test(f.question))).toBe(false);
    expect(faqs.some((f) => /services do you offer/i.test(f.question))).toBe(false);
    expect(faqs.length).toBe(3);
  });
});

describe("buildAgentConfig", () => {
  const config = buildAgentConfig({
    company: { name: "Ocean Crest Painting", phone: "+18505550199", timezone: "America/Chicago" },
    services: ["Interior painting"],
    serviceArea: "Pensacola",
    faqs: defaultVoiceFaqs({ companyName: "Ocean Crest Painting", services: ["Interior painting"], serviceArea: "Pensacola" }),
    tools: {
      checkAvailabilityUrl: "https://api.example/voice/availability",
      bookAppointmentUrl: "https://api.example/voice/book",
      toolToken: "tok_secret",
    },
    webhookUrl: "https://api.example/voice/webhook/retell",
  });

  it("greets with the company's name by default", () => {
    expect(config.version).toBe(VOICE_AGENT_CONFIG_VERSION);
    expect(config.greeting).toContain("Ocean Crest Painting");
    expect(config.greeting).toContain("book you a free estimate");
    expect(config.webhook.url).toBe("https://api.example/voice/webhook/retell");
  });

  it("teaches both paths in the prompt, with the booking tools and the no-inventing rules", () => {
    expect(config.system_prompt).toContain("BOOK A FREE ESTIMATE");
    expect(config.system_prompt).toContain("TAKE A MESSAGE");
    expect(config.system_prompt).toContain("check_availability");
    expect(config.system_prompt).toContain("book_appointment");
    expect(config.system_prompt).toContain("Never invent");
    expect(config.system_prompt).toContain("America/Chicago");
  });

  it("carries the token header and URLs in both platforms' tool shapes", () => {
    expect(config.tools.map((t) => t.name)).toEqual(["check_availability", "book_appointment"]);
    const retell = config.retell.custom_functions;
    expect(retell).toHaveLength(2);
    expect(retell[0].url).toBe("https://api.example/voice/availability");
    expect(retell[0].headers).toEqual({ Authorization: "Bearer tok_secret" });
    expect(retell[1].parameters.required).toContain("starts_at");
    const vapi = config.vapi.tools;
    expect(vapi).toHaveLength(2);
    expect(vapi[0].type).toBe("function");
    expect(vapi[0].function.name).toBe("check_availability");
    expect(vapi[1].server.url).toBe("https://api.example/voice/book");
    expect(vapi[1].server.headers).toEqual({ Authorization: "Bearer tok_secret" });
  });

  it("keeps a company's own greeting when it gives one", () => {
    const custom = buildAgentConfig({
      company: { name: "JC Landscaping" },
      services: [],
      faqs: [],
      greeting: "Hey, JC Landscaping here — how can I help?",
      tools: { checkAvailabilityUrl: "https://a", bookAppointmentUrl: "https://b", toolToken: "t" },
      webhookUrl: "https://w",
    });
    expect(custom.greeting).toBe("Hey, JC Landscaping here — how can I help?");
  });
});

describe("aiCallListItem", () => {
  it("shapes a booked call for the list", () => {
    const item = aiCallListItem({
      id: "row1",
      caller_name: "Geoff Larue",
      caller_phone: "+18505550101",
      started_at: "2026-11-27T14:00:00.000Z",
      created_at: "2026-11-27T14:03:00.000Z",
      duration_seconds: 200,
      outcome: "booked",
      summary: "Booked an exterior estimate.",
      transcript: "Agent: ...",
      recording_url: "https://rec.example/1.wav",
      request_id: "req1",
      visit_id: "visit1",
    });
    expect(item).toEqual({
      id: "row1",
      when: "2026-11-27T14:00:00.000Z",
      callerLabel: "Geoff Larue",
      durationLabel: "3m 20s",
      outcome: "booked",
      outcomeLabel: "Booked a visit",
      summary: "Booked an exterior estimate.",
      booked: true,
      hasTranscript: true,
      hasRecording: true,
      requestId: "req1",
      visitId: "visit1",
    });
  });

  it("falls back for an unknown caller, a short call, and a bogus outcome", () => {
    const item = aiCallListItem({
      id: "row2",
      created_at: "2026-11-27T14:03:00.000Z",
      duration_seconds: 45,
      outcome: "sold-the-house",
    });
    expect(item.callerLabel).toBe("Unknown caller");
    expect(item.durationLabel).toBe("45s");
    expect(item.outcome).toBe("unknown");
    expect(item.outcomeLabel).toBe(VOICE_OUTCOME_LABELS.unknown);
    expect(item.booked).toBe(false);
    expect(item.hasTranscript).toBe(false);
    expect(item.when).toBe("2026-11-27T14:03:00.000Z");
    const noDuration = aiCallListItem({ id: "row3", created_at: "2026-11-27T14:03:00.000Z", outcome: "faq" });
    expect(noDuration.durationLabel).toBe("—");
    expect(noDuration.outcomeLabel).toBe("Answered a question");
  });
});

describe("the vocabulary", () => {
  it("names both platforms and a label for every outcome", () => {
    expect(VOICE_PLATFORMS).toEqual(["retell", "vapi"]);
    expect(Object.keys(VOICE_OUTCOME_LABELS).sort()).toEqual(
      ["booked", "faq", "message", "other", "transferred", "unknown"].sort(),
    );
  });
});
