/**
 * Making a postcard campaign's cards (services/postcards.ts): one Lob request per client, each with
 * the recipient's own idempotency key, so a card tried again is the card Lob already made; a client
 * who opted out or was archived after Send is skipped; a campaign never goes on with a key of the
 * other kind, or once Marketing is off or Lob is disconnected. The database keeps its rows in memory
 * and claims, renews, records and puts back recipients as 20261113001400_postcards.sql does (which
 * supabase/tests/postcards_test.sql tests against Postgres). Lob answers what each test gives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { processPostcards, sendProblem } from "../src/services/postcards";

const current = vi.hoisted(() => ({ db: null as unknown, key: "test_0123456789abcdef0123" as string | null }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db }));
vi.mock("../src/integrations/tokens", async (original) => ({
  ...(await original<typeof import("../src/integrations/tokens")>()),
  loadSecret: async () => (current.key ? { api_key: current.key } : null),
}));

const env: Env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://crew.example.com" };
const CO = "00000000-0000-4000-8000-0000000000c0";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000ca";

type Row = Record<string, any>;

function memoryDb(tables: Record<string, Row[]>) {
  let claims = 0;
  const calls: string[] = [];
  const recipients = () => tables.postcard_recipients!;
  const held = (id: number, token: string) => recipients().find((r) => r.id === id && r.status === "sending" && r.claim_token === token);
  const rpcs: Record<string, (a: Row) => unknown> = {
    claim_postcard_recipients: ({ p_campaign, p_limit }) => {
      const token = `claim-${++claims}`;
      return recipients()
        .filter((r) => r.campaign_id === p_campaign && r.status === "pending")
        .slice(0, p_limit)
        .map((r) => ({ ...Object.assign(r, { status: "sending", claim_token: token }) }));
    },
    renew_postcard_recipient: ({ p_id, p_token }) => {
      const r = held(p_id, p_token);
      if (r) r.attempts += 1;
      return Boolean(r);
    },
    finish_postcard_recipient: ({ p_id, p_token, p_status, p_error, p_lob_id, p_expected }) => {
      const r = held(p_id, p_token);
      if (r) Object.assign(r, { status: p_status, error: p_error ?? null, lob_id: p_lob_id ?? null, expected_delivery: p_expected ?? null, claim_token: null });
      return Boolean(r);
    },
    release_postcard_recipients: ({ p_token, p_ids }) => {
      const rows = recipients().filter((r) => p_ids.includes(r.id) && r.status === "sending" && r.claim_token === p_token);
      for (const r of rows) Object.assign(r, { status: "pending", claim_token: null });
      return rows.length;
    },
    stop_postcard_campaign: ({ p_campaign, p_reason }) => {
      for (const c of tables.postcard_campaigns!) if (c.id === p_campaign && c.status === "sending") Object.assign(c, { status: "cancelled", stopped_reason: p_reason });
      for (const r of recipients()) if (r.campaign_id === p_campaign && r.status === "pending") Object.assign(r, { status: "skipped", error: p_reason });
      return null;
    },
    count_postcard_campaign: ({ p_campaign }) => {
      const mine = recipients().filter((r) => r.campaign_id === p_campaign);
      const left = mine.filter((r) => ["pending", "sending"].includes(r.status)).length;
      for (const c of tables.postcard_campaigns!) {
        if (c.id !== p_campaign) continue;
        c.made_count = mine.filter((r) => r.status === "made").length;
        if (c.status === "sending" && !left) c.status = "sent";
      }
      return null;
    },
  };
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let update: Row | null = null;
    let single = false;
    let limit = Infinity;
    const run = () => {
      const rows = (tables[table] ??= []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
      if (update) {
        for (const r of rows) Object.assign(r, update);
        return { data: null, error: null };
      }
      const data = rows.map((r) => ({ ...r }));
      return { data: single ? (data[0] ?? null) : data, error: null };
    };
    const q: any = {
      select: () => q,
      update: (values: Row) => ((update = values), q),
      eq: (column: string, value: unknown) => (filters.push((r) => r[column] === value), q),
      neq: (column: string, value: unknown) => (filters.push((r) => r[column] !== value), q),
      match: (values: Row) => (filters.push((r) => Object.entries(values).every(([k, v]) => r[k] === v)), q),
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => ((single = true), q),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  }
  return {
    calls,
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Row) => {
      calls.push(fn);
      return { data: rpcs[fn]!(args), error: null };
    },
  };
}

const address = { line1: "12 Oak St", city: "Springfield", region: "IL", postal_code: "62701", country: "US" };
function world(mode: "test" | "live" = "test") {
  return {
    companies: [{ id: CO, name: "Sketchy Gutters", phone: "(540) 555-0100", website: "https://sketchy.example.com", slug: "sketchy", address: { line1: "1 Main St", city: "Springfield", region: "IL", postal_code: "62701" }, settings: { marketing: { enabled: true } } }],
    integrations: [{ company_id: CO, provider: "lob", status: "connected", settings: { mode } }],
    intake_forms: [{ company_id: CO, slug: "spring", active: true }],
    postcard_campaigns: [{ id: CAMPAIGN, company_id: CO, name: "Spring cards", size: "4x6", message: "Hi {{client.first_name}}, book at {{link}}", mode, status: "sending", image_token: "t".repeat(32), made_count: 0 }],
    clients: [
      { id: "ann", status: "active", marketing_opt_out: false },
      { id: "bob", status: "active", marketing_opt_out: true },
      { id: "cy", status: "archived", marketing_opt_out: false },
    ],
    postcard_recipients: [
      { id: 1, campaign_id: CAMPAIGN, client_id: "ann", name: "Ann Oak", address, idempotency_key: "key-ann", status: "pending", attempts: 0, claim_token: null },
      { id: 2, campaign_id: CAMPAIGN, client_id: "bob", name: "Bob Ash", address, idempotency_key: "key-bob", status: "pending", attempts: 0, claim_token: null },
      { id: 3, campaign_id: CAMPAIGN, client_id: "cy", name: "Cy Elm", address, idempotency_key: "key-cy", status: "pending", attempts: 0, claim_token: null },
    ] as Row[],
  };
}

const lobAnswer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let sent: Array<{ key: string; auth: string; body: Row }>;
let answers: Array<() => Response>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  sent = [];
  answers = [];
  current.key = "test_0123456789abcdef0123";
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ key: headers["Idempotency-Key"]!, auth: atob(headers.Authorization!.replace("Basic ", "")), body: JSON.parse(String(init.body)) });
    return (answers.shift() ?? (() => lobAnswer(200, { id: `psc_${sent.length}`, expected_delivery_date: "2026-11-20" })))();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs the task, letting its spacing between cards pass. */
async function run() {
  const done = processPostcards(env);
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(300);
  return done;
}

describe("making a campaign's cards", () => {
  it("makes one card per client with their own idempotency key, and skips who opted out or was archived since Send", async () => {
    const tables = world();
    current.db = memoryDb(tables);
    const counts = await run();
    expect(counts).toMatchObject({ made: 1, skipped: 2, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe("key-ann");
    expect(sent[0]!.auth).toBe("test_0123456789abcdef0123:");
    expect(sent[0]!.body.to).toMatchObject({ name: "Ann Oak", address_zip: "62701" });
    expect(sent[0]!.body.from).toMatchObject({ name: "Sketchy Gutters", address_line1: "1 Main St" });
    expect(sent[0]!.body.front).toContain(`https://crew.example.com/api/public/postcards/${"t".repeat(32)}.jpg`);
    // The merge fields are filled in, {{link}} as the booking form.
    expect(sent[0]!.body.back).toContain("Hi Ann, book at https://crew.example.com/book/sketchy/spring");
    const [ann, bob, cy] = tables.postcard_recipients;
    expect(ann).toMatchObject({ status: "made", lob_id: "psc_1", expected_delivery: "2026-11-20" });
    expect(bob).toMatchObject({ status: "skipped", error: "Opted out of marketing" });
    expect(cy).toMatchObject({ status: "skipped", error: "Client was archived" });
    expect(tables.postcard_campaigns[0]!.status).toBe("sent");
  });

  it("tries a card Lob didn't answer for again with the same key, so it's never made twice", async () => {
    const tables = world();
    tables.postcard_recipients = tables.postcard_recipients.slice(0, 1);
    current.db = memoryDb(tables);
    answers.push(() => lobAnswer(503, { error: { message: "busy" } }));
    await run();
    expect(tables.postcard_recipients[0]).toMatchObject({ status: "pending", attempts: 1 });
    await run();
    expect(tables.postcard_recipients[0]).toMatchObject({ status: "made", attempts: 2 });
    expect(sent.map((s) => s.key)).toEqual(["key-ann", "key-ann"]);
  });

  it("gives up on a card after five tries, saying why", async () => {
    const tables = world();
    tables.postcard_recipients = tables.postcard_recipients.slice(0, 1);
    current.db = memoryDb(tables);
    for (let i = 0; i < 5; i++) answers.push(() => lobAnswer(500, {}));
    for (let i = 0; i < 5; i++) await run();
    expect(tables.postcard_recipients[0]).toMatchObject({ status: "failed", attempts: 5 });
    expect(tables.postcard_recipients[0]!.error).toMatch(/Lob had a problem/);
    expect(new Set(sent.map((s) => s.key))).toEqual(new Set(["key-ann"]));
  });

  it("records an address Lob refuses as failed with Lob's reason, and goes on with the rest", async () => {
    const tables = world();
    tables.clients[1]!.marketing_opt_out = false;
    tables.clients[2]!.status = "active";
    current.db = memoryDb(tables);
    answers.push(() => lobAnswer(422, { error: { message: "address is undeliverable" } }));
    const counts = await run();
    expect(counts).toMatchObject({ made: 2, failed: 1 });
    expect(tables.postcard_recipients[0]).toMatchObject({ status: "failed", error: "Lob refused this card: address is undeliverable" });
  });

  it("never mails from a key of the other kind: a test campaign stops when the key becomes live", async () => {
    const tables = world("test");
    tables.integrations[0]!.settings = { mode: "live" };
    current.key = "live_0123456789abcdef0123";
    current.db = memoryDb(tables);
    await run();
    expect(sent).toHaveLength(0);
    expect(tables.postcard_campaigns[0]).toMatchObject({ status: "cancelled" });
    expect(tables.postcard_campaigns[0]!.stopped_reason).toMatch(/changed to a live key/);
    expect(tables.postcard_recipients.every((r) => r.status === "skipped")).toBe(true);
  });

  it("stops when Marketing is uninstalled or Lob disconnected, and mails nothing", async () => {
    const off = world("live");
    off.companies[0]!.settings = { marketing: { enabled: false } };
    current.db = memoryDb(off);
    await run();
    expect(off.postcard_campaigns[0]!.stopped_reason).toMatch(/Marketing was turned off/);
    const gone = world("live");
    gone.integrations[0]!.status = "disconnected";
    current.db = memoryDb(gone);
    await run();
    expect(gone.postcard_campaigns[0]!.stopped_reason).toMatch(/Lob was disconnected/);
    expect(sent).toHaveLength(0);
  });

  it("stops at once when Lob refuses the key, and marks the connection", async () => {
    const tables = world("live");
    current.key = "live_0123456789abcdef0123";
    current.db = memoryDb(tables);
    answers.push(() => lobAnswer(401, {}));
    await run();
    expect(sent).toHaveLength(1);
    expect(tables.integrations[0]).toMatchObject({ status: "error" });
    expect(tables.postcard_campaigns[0]!.status).toBe("cancelled");
    expect(tables.postcard_recipients.every((r) => r.status === "skipped")).toBe(true);
  });
});

describe("what Send needs first", () => {
  const ready = { marketing: true, lob: true, publicAddress: true, returnAddress: true, front: true, message: "Hi there, book your spring visit.", size: "4x6" as const };
  it("says the first thing in the way, in the order it's fixed", () => {
    expect(sendProblem(ready)).toBeNull();
    expect(sendProblem({ ...ready, marketing: false, lob: false })).toMatch(/Marketing is off/);
    expect(sendProblem({ ...ready, lob: false })).toMatch(/Lob isn't connected/);
    expect(sendProblem({ ...ready, publicAddress: false })).toMatch(/isn't public/);
    expect(sendProblem({ ...ready, returnAddress: false })).toMatch(/return address/);
    expect(sendProblem({ ...ready, front: false })).toMatch(/picture for the front/);
    expect(sendProblem({ ...ready, message: "x".repeat(800) })).toMatch(/fits about 500/);
  });
});
