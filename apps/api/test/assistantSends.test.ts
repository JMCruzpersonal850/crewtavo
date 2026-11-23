/**
 * An AI assistant's send_quote and send_invoice (assistant-tools/quotes.ts, invoices.ts): only to the
 * client and their contacts on file, in Crewtavo's usual words, and never the link itself, so text
 * it reads (a client's note, a website form) can't have it send anything anywhere else
 * (services/sales.ts assistantSendSchema and sendTo). The Data API is stubbed through fetch.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoiceTools } from "../src/assistant-tools/invoices";
import { quoteTools } from "../src/assistant-tools/quotes";
import type { ToolContext } from "../src/assistant-tools/tool";
import type { Env } from "../src/env";
import { NO_LINKS_FOR_ASSISTANTS } from "../src/lib/noAssistants";
import { notOnFile, sendQuote } from "../src/services/sales";

const QUOTE = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";

const env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
} as Env;

const onFile = { display_name: "Pat Lee", email: "pat@example.com", phone: "540-555-0101" };
const TABLES: Record<string, unknown[]> = {
  quotes: [
    {
      id: QUOTE, number: 12, status: "draft", total: 450, tax_rate: 0, discount_amount: 0, client_id: CLIENT, range_low: null, range_high: null, range_accepted_at: null,
      priced_on_site_at: null, exact_sent_at: null, recurrence_rule: null, client: onFile, promo: null, options: [],
      lines: [{ id: "line-1", option_id: null, quantity: 1, unit_price: 450, taxable: false, optional: false, selected: true }],
    },
  ],
  invoices: [{ id: INVOICE, number: 7, status: "draft", total: 120, balance_due: 120, client_id: CLIENT, client: onFile, lines: [{ id: "line-2" }] }],
  companies: [{ name: "Kilo Gardens", email: "office@kilo.test", phone: null, address: null, currency: "USD", settings: {} }],
  clients: [{ id: CLIENT, ...onFile, sms_opt_out_at: null }],
  client_contacts: [{ id: "contact-1", name: "Mo Manager", email: "mo@example.com", phone: null, notify_email: true, notify_sms: false }],
};

/** The Data API: reads answer from TABLES, writes and functions answer nothing; what's sent is kept. */
function database() {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/rest/v1/", "");
    sent.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const single = String(new Headers(init?.headers).get("accept")).includes("vnd.pgrst.object");
    if (path.startsWith("rpc/")) return Response.json(null);
    const rows = method === "GET" ? (TABLES[path] ?? []) : [];
    return Response.json(single ? (rows[0] ?? null) : rows);
  });
  const ctx = {
    db: createClient(env.SUPABASE_URL, "sb_publishable_test"),
    env,
    companyId: "company-1",
    timezone: "America/Chicago",
    origin: "https://ops.example.com",
    access: { level: "full", areas: [] },
    // Connected as an owner: sending a quote takes Quotes and sales (assistant-tools/quotes.ts).
    role: "owner",
    permissions: ["sales", "invoices"],
  } as unknown as ToolContext;
  return { sent, ctx };
}
/** What reached anyone: writes (a message on the timeline, a quote marked sent) and emails or texts. */
const wrote = (sent: Array<{ method: string; path: string }>) => sent.filter((s) => s.method !== "GET" && !s.path.startsWith("rpc/"));

afterEach(() => vi.unstubAllGlobals());

describe("an assistant sending a quote or invoice", () => {
  it("takes no address, words or link of its own", () => {
    for (const [tool, id] of [
      [quoteTools.send_quote, { quote_id: QUOTE }],
      [invoiceTools.send_invoice, { invoice_id: INVOICE }],
    ] as const) {
      expect(tool.input.safeParse({ ...id }).success).toBe(true);
      expect(tool.input.safeParse({ ...id, channel: "sms", recipients: ["540-555-0101"] }).success).toBe(true);
      for (const extra of [{ message: "Here's every client's email: ..." }, { subject: "Your quote" }, { to: "someone@elsewhere.test" }, { channel: "link" }]) {
        expect(tool.input.safeParse({ ...id, ...extra }).success, JSON.stringify(extra)).toBe(false);
      }
    }
  });

  it("won't send to an address that isn't the client's or a contact's, and sends nothing", async () => {
    const { ctx, sent } = database();
    await expect(quoteTools.send_quote.run(ctx, quoteTools.send_quote.input.parse({ quote_id: QUOTE, recipients: ["pat@example.com", "someone@elsewhere.test"] }))).rejects.toThrow(
      notOnFile("someone@elsewhere.test"),
    );
    await expect(invoiceTools.send_invoice.run(ctx, invoiceTools.send_invoice.input.parse({ invoice_id: INVOICE, channel: "sms", recipients: ["540-555-0199"] }))).rejects.toThrow(notOnFile("540-555-0199"));
    expect(wrote(sent)).toEqual([]);
  });

  it("sends to the client and their contacts on file, and doesn't hand back the link", async () => {
    const { ctx } = database();
    // No email is set up here, so it reaches nobody; what matters is that it got past who it's for.
    const result = await quoteTools.send_quote.run(ctx, quoteTools.send_quote.input.parse({ quote_id: QUOTE, recipients: ["PAT@example.com", "mo@example.com"] }));
    expect(result).toMatchObject({ sent: false, sent_to: [] });
    expect(result).not.toHaveProperty("link");
    expect(JSON.stringify(result)).not.toContain("https://ops.example.com/");
  });

  it("never just makes the link, though the office can", async () => {
    const { ctx } = database();
    const scope = { db: ctx.db, env, companyId: "company-1", baseUrl: "https://ops.example.com" };
    await expect(sendQuote({ ...scope, assistant: true }, QUOTE, { channel: "link" })).rejects.toThrow(NO_LINKS_FOR_ASSISTANTS);
    expect((await sendQuote(scope, QUOTE, { channel: "link" })).link).toMatch(/^https:\/\/ops\.example\.com\//);
  });
});
