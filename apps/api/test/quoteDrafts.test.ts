/**
 * Draft a quote from a request (services/quoteDrafts.ts), against a stand-in for PostgREST with
 * Claude mocked: only price list items make it onto the quote, at the price list's prices, whatever
 * Claude says; a quantity the request didn't give is 1 to check; without Claude (off, or failing)
 * the draft takes the items whose names match the client's choices; and the switch is only turned on
 * once Claude answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { HttpError } from "../src/lib/http";
import { adminClient } from "../src/lib/supabase";
import {
  draftArrivedRequest,
  draftQuote,
  matchPriceList,
  priceListDraft,
  readJsonAnswer,
  requestAnswers,
  setQuoteAi,
  validateDraft,
  type PriceItem,
} from "../src/services/quoteDrafts";

const ai = vi.hoisted(() => ({ complete: vi.fn(), count: vi.fn(async () => undefined), key: vi.fn(async () => null) }));
vi.mock("../src/services/ai", async (original) => ({
  ...(await original<typeof import("../src/services/ai")>()),
  complete: ai.complete,
  countAiAsk: ai.count,
  companyAnthropicKey: ai.key,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crew.example.com",
};

const MOW = "11111111-1111-4111-8111-111111111111";
const EDGE = "22222222-2222-4222-8222-222222222222";
const LEAVES = "33333333-3333-4333-8333-333333333333";
const items: PriceItem[] = [
  { id: MOW, name: "Mowing", description: "Up to a quarter acre", category: "Lawn", unit: "visit", unit_price: 45, taxable: false },
  { id: EDGE, name: "Edging", description: null, category: "Lawn", unit: "ft", unit_price: 0.5, taxable: false },
  { id: LEAVES, name: "Leaf cleanup", description: null, category: "Fall", unit: "ea", unit_price: 180, taxable: true },
];
const questions = [
  { key: "service", label: "What do you need?", type: "multi_choice", options: ["Weekly mowing", "Leaf cleanup", "Aeration"] },
  { key: "feet", label: "How many feet of edging?", type: "number" },
  { key: "photos", label: "Photos", type: "photos" },
  { key: "gate", label: "Gate code", type: "text" },
];
const answers = { service: ["Weekly mowing", "Aeration"], feet: 120, photos: ["a.jpg"], gate: "4421", email: "pat@example.com", name: "Pat" };

describe("what a draft goes by", () => {
  it("reads the answers under their questions, leaving out files and the contact details typed", () => {
    expect(requestAnswers(questions, answers)).toEqual([
      { label: "What do you need?", value: "Weekly mowing, Aeration", choice: true },
      { label: "How many feet of edging?", value: "120", choice: false },
      { label: "Gate code", value: "4421", choice: false },
    ]);
    expect(requestAnswers(null, { when: "As soon as possible", ok: true })).toEqual([
      { label: "when", value: "As soon as possible", choice: false },
      { label: "ok", value: "Yes", choice: false },
    ]);
  });

  it("matches price list names to what the client picked, by whole words", () => {
    expect(matchPriceList(["Weekly mowing, Aeration"], items).map((i) => i.name)).toEqual(["Mowing"]);
    expect(matchPriceList(["Leaf cleanup"], items).map((i) => i.name)).toEqual(["Leaf cleanup"]);
    // "mow" isn't "Mowing", and two letters match nothing.
    expect(matchPriceList(["mow", "ed"], items)).toEqual([]);
    expect(priceListDraft(requestAnswers(questions, answers), "Lawn care request", items)).toEqual([
      { service_id: MOW, name: "Mowing", description: "Up to a quarter acre", quantity: 1, unit: "visit", unit_price: 45, taxable: false, check: true },
    ]);
  });
});

describe("checking what Claude proposes", () => {
  it("keeps only price list items, at the price list's price, name and tax, each once", () => {
    const raw = {
      description: " Weekly mowing and edging for the front and back.  ",
      lines: [
        { id: MOW, quantity: 4, unit_price: 1, name: "Mowing (special)" },
        { id: "99999999-9999-4999-8999-999999999999", quantity: 1, name: "Gold-plated mower", unit_price: 5000 },
        { name: "Fertilizer", quantity: 2, unit_price: 30 },
        { id: EDGE, quantity: "120" },
        { id: MOW, quantity: 2 },
        { id: LEAVES },
        { id: LEAVES.toUpperCase(), quantity: 1 },
      ],
    };
    const { description, lines, dropped } = validateDraft(raw, items);
    expect(description).toBe("Weekly mowing and edging for the front and back.");
    expect(lines).toEqual([
      { service_id: MOW, name: "Mowing", description: "Up to a quarter acre", quantity: 4, unit: "visit", unit_price: 45, taxable: false, check: false },
      { service_id: EDGE, name: "Edging", description: null, quantity: 120, unit: "ft", unit_price: 0.5, taxable: false, check: false },
      { service_id: LEAVES, name: "Leaf cleanup", description: null, quantity: 1, unit: "ea", unit_price: 180, taxable: true, check: true },
    ]);
    expect(dropped).toBe(4);
  });

  it("checks every quantity it gives, and reads its JSON from a code block", () => {
    const quantities = [0, -2, 1e9, Number.NaN, "lots", 2.12345];
    const { lines } = validateDraft({ lines: quantities.map((q, i) => ({ id: items[i % 3]!.id === MOW && i ? "x" : items[i % 3]!.id, quantity: q })) }, items);
    expect(lines.map((l) => [l.quantity, l.check])).toEqual([[1, true], [1, true], [1, true]]);
    expect(validateDraft({ lines: [{ id: EDGE, quantity: 2.12345 }] }, items).lines[0]!.quantity).toBe(2.123);
    expect(readJsonAnswer('Here you go:\n```json\n{"lines": []}\n```')).toEqual({ lines: [] });
    expect(readJsonAnswer("I can't help with that.")).toBeNull();
    expect(validateDraft(null, items)).toEqual({ description: null, lines: [], dropped: 0 });
    expect(validateDraft({ lines: "everything" }, items)).toEqual({ description: null, lines: [], dropped: 0 });
  });
});

interface Call {
  method: string;
  path: string;
  url: URL;
  body: any;
}

/** PostgREST for one request at a company with this price list; `settings` is the company's. */
function serve(settings: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const answer = (() => {
      if (call.path === "requests" && call.method === "GET") {
        return {
          id: "req-1", number: 12, title: "Lawn care", details: "Front and back yard", answers, source: "web_form", client_id: "cl-1", property_id: "pr-1", assigned_to: null,
          form: { name: "Lawn care request", questions }, property: { line1: "1 Elm St", city: "Austin", region: "TX", lot_size_sqft: 8000, notes: null }, files: [{ title: "Back yard" }],
          client: { display_name: "Pat Lee" },
        };
      }
      if (call.path === "companies") return { name: "Green Acres", settings };
      if (call.path === "services") return items;
      if (call.path === "quotes" && call.method === "POST") return { id: "q-1", number: 40 };
      if (call.path === "quote_line_items" && call.method === "POST") return (call.body as unknown[]).map((_, i) => ({ id: `line-${i}`, sort: i }));
      if (call.path === "memberships") return [{ user_id: "u-owner" }, { user_id: "u-office" }];
      if (call.path === "rpc/set_quote_ai") return { on: true, checked_at: "2026-11-13T12:00:00Z" };
      return null;
    })();
    return Response.json(answer);
  });
  return calls;
}

const scope = () => ({ db: adminClient(env), env, companyId: "co-1", baseUrl: "https://crew.example.com" });
const drafted = (calls: Call[]) => calls.find((c) => c.path === "quotes" && c.method === "PATCH")?.body;
const inserted = (calls: Call[]) => calls.find((c) => c.path === "quote_line_items" && c.method === "POST")?.body;

beforeEach(() => {
  ai.complete.mockReset();
  ai.count.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("Draft a quote", () => {
  it("with Claude on: the lines Claude picked from the price list, at its prices, and its description; invented items and prices are dropped", async () => {
    const calls = serve({ quote_ai: { on: true } });
    ai.complete.mockResolvedValueOnce(JSON.stringify({
      description: "Weekly mowing and 120 feet of edging.",
      lines: [{ id: MOW, unit_price: 5 }, { id: EDGE, quantity: 120, unit_price: 0.01 }, { name: "Pressure washing", unit_price: 300, quantity: 1 }],
    }));
    const result = await draftQuote(scope(), "req-1", "u-1");
    expect(result).toEqual({ id: "q-1", number: 40, by: "claude", lines: 2, check: 1, note: null });
    expect(ai.count).toHaveBeenCalledWith(env, "co-1", "u-1");
    expect(inserted(calls)).toEqual([
      { company_id: "co-1", quote_id: "q-1", service_id: MOW, name: "Mowing", description: "Up to a quarter acre", quantity: 1, unit: "visit", unit_price: 45, taxable: false, sort: 0 },
      { company_id: "co-1", quote_id: "q-1", service_id: EDGE, name: "Edging", description: null, quantity: 120, unit: "ft", unit_price: 0.5, taxable: false, sort: 1 },
    ]);
    expect(drafted(calls)).toMatchObject({
      message: "Weekly mowing and 120 feet of edging.",
      drafted: { by: "claude", request_number: 12, check: ["line-0"], note: null, notes: "What do you need?: Weekly mowing, Aeration\nHow many feet of edging?: 120\nGate code: 4421" },
    });
    // What Claude is shown: the request, the property, the photo captions and the price list without prices.
    const prompt = JSON.parse(ai.complete.mock.calls[0]![1].prompt);
    expect(prompt.request.photo_captions).toEqual(["Back yard"]);
    expect(prompt.property.lot_size_sqft).toBe(8000);
    expect(prompt.price_list[0]).toEqual({ id: MOW, name: "Mowing", description: "Up to a quarter acre", unit: "visit", category: "Lawn" });
    expect(ai.complete.mock.calls[0]![1].system).toContain("never make up an item, a price or a discount");
  });

  it("with Claude off: the price list items matching the client's choices, nothing asked of Claude", async () => {
    const calls = serve({});
    const result = await draftQuote(scope(), "req-1", "u-1");
    expect(result).toEqual({ id: "q-1", number: 40, by: "price_list", lines: 1, check: 1, note: null });
    expect(ai.complete).not.toHaveBeenCalled();
    expect(ai.count).not.toHaveBeenCalled();
    expect(inserted(calls).map((l: { name: string }) => l.name)).toEqual(["Mowing"]);
    expect(drafted(calls)).not.toHaveProperty("message");
  });

  it("when Claude fails, falls back to the price list and says why", async () => {
    const calls = serve({ quote_ai: { on: true } });
    ai.complete.mockRejectedValueOnce(new HttpError(429, "The AI is busy right now. Try again in a minute."));
    const result = await draftQuote(scope(), "req-1", "u-1");
    expect(result.by).toBe("price_list");
    expect(result.note).toBe("Claude couldn't draft this one (The AI is busy right now. Try again in a minute), so it was drafted from your price list.");
    expect(drafted(calls).drafted.note).toBe(result.note);
  });

  it("drafts a request that just came in only when the company asks, counts it against the company, and tells the office", async () => {
    serve({ quote_ai: { on: true } });
    expect(await draftArrivedRequest(env, "co-1", "req-1")).toBeNull();
    const calls = serve({ quote_ai: { on: true }, quotes: { draft_requests: true } });
    ai.complete.mockResolvedValueOnce(JSON.stringify({ lines: [{ id: MOW, quantity: 1 }] }));
    expect(await draftArrivedRequest(env, "co-1", "req-1")).toMatchObject({ id: "q-1", by: "claude" });
    expect(ai.count).toHaveBeenCalledWith(env, "co-1", null);
    expect(calls.find((c) => c.path === "notifications")?.body).toEqual([
      { company_id: "co-1", user_id: "u-owner", kind: "quote", title: "A draft quote is ready for request #12 from Pat Lee", body: "Claude drafted it from the request and your price list. Look it over before you send it.", link: "/quotes/q-1" },
      { company_id: "co-1", user_id: "u-office", kind: "quote", title: "A draft quote is ready for request #12 from Pat Lee", body: "Claude drafted it from the request and your price list. Look it over before you send it.", link: "/quotes/q-1" },
    ]);
  });
});

describe("Draft quotes with Claude, the switch", () => {
  it("turns on only once Claude answers, and says what to fix when it doesn't", async () => {
    let calls = serve({});
    ai.complete.mockRejectedValueOnce(new HttpError(501, "AI isn't turned on yet. An admin can add a Claude key on the Apps page."));
    await expect(setQuoteAi(env, "co-1", "u-1", true)).rejects.toThrow("Add a Claude key in Apps → Claude first, then turn this on.");
    ai.complete.mockRejectedValueOnce(new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly."));
    await expect(setQuoteAi(env, "co-1", "u-1", true)).rejects.toThrow("Claude didn't answer, so this is still off. The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    expect(calls.some((c) => c.path === "rpc/set_quote_ai")).toBe(false);

    calls = serve({});
    ai.complete.mockResolvedValueOnce("OK");
    expect(await setQuoteAi(env, "co-1", "u-1", true)).toMatchObject({ on: true });
    expect(calls.find((c) => c.path === "rpc/set_quote_ai")?.body).toEqual({ p_company: "co-1", p_on: true, p_by: "u-1" });

    calls = serve({});
    ai.complete.mockReset();
    await setQuoteAi(env, "co-1", "u-1", false);
    expect(ai.complete).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path === "rpc/set_quote_ai")?.body).toEqual({ p_company: "co-1", p_on: false, p_by: "u-1" });
  });
});
