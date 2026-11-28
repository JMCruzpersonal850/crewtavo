/**
 * The review gate (routes/public.ts): a tracked review link no longer redirects straight to the
 * business's review page. Opening it counts the ask's open (track_review_click, which stops its
 * reminders) and lands the client on the web's star gate (/r/<token>); the gate's facts name the
 * review page 4-5 stars go on to, and 1-3 stars post private feedback into review_feedback
 * instead — one note per ask, and never for 4-5 stars. PostgREST is a stand-in over fetch that
 * keeps its rows, so a second feedback submit sees the first one's note.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/app";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA_ID = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "AbCdEf123456";
const REVIEW_URL = "https://g.page/r/acme/review";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  body: any;
}

/** PostgREST over fetch, stateful: an insert lands in its table, so later reads see it. */
function serve() {
  const calls: Call[] = [];
  const tables: Record<string, Row[]> = {
    companies: [{ id: CO, name: "Acme Lawn", settings: { review_url: REVIEW_URL } }],
    review_requests: [{ id: "rr-1", company_id: CO, client_id: ANA_ID, job_id: "job-1", link_token: TOKEN }],
    review_feedback: [],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // a form
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, body };
    calls.push(call);
    if (path.startsWith("rpc/")) return Response.json(true);
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
        else if (filter.startsWith("in.(")) rows = rows.filter((r) => filter.slice(4, -1).split(",").includes(String(r[column])));
      }
      return Response.json(rows);
    }
    if (call.method === "POST" && tables[path]) tables[path].push(body as Row);
    return Response.json([]);
  });
  return { calls, tables };
}

afterEach(() => vi.unstubAllGlobals());

const get = (path: string, headers?: Record<string, string>) => app.request(`/api${path}`, { headers }, env);
const post = (path: string, body: unknown) =>
  app.request(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
const inserts = (calls: Call[], table: string) => calls.filter((c) => c.method === "POST" && c.path === table).map((c) => c.body);

describe("the tracked review link", () => {
  it("counts the open — which stops the ask's reminders — and lands on the star gate, not the review page", async () => {
    const { calls } = serve();
    const res = await get(`/public/r/${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/r/${TOKEN}`);
    expect(rpcCalls(calls, "track_review_click")).toEqual([{ p_token: TOKEN, p_count: true }]);
  });

  it("still lands a link preview on the gate, but doesn't count it as the client's open", async () => {
    const { calls } = serve();
    const res = await get(`/public/r/${TOKEN}`, { "User-Agent": "facebookexternalhit/1.1 Facebot" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/r/${TOKEN}`);
    expect(rpcCalls(calls, "track_review_click")).toEqual([{ p_token: TOKEN, p_count: false }]);
  });

  it("404s a token no ask carries", async () => {
    serve();
    expect((await get("/public/r/NopeNopeNope")).status).toBe(404);
  });
});

describe("the gate's facts", () => {
  it("name the business and the review page 4-5 stars go on to, and count the open too", async () => {
    const { calls } = serve();
    const res = await get(`/public/r/${TOKEN}/gate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ company: "Acme Lawn", review_url: REVIEW_URL });
    expect(rpcCalls(calls, "track_review_click")).toEqual([{ p_token: TOKEN, p_count: true }]);
  });

  it("404s for a token no ask carries", async () => {
    serve();
    expect((await get("/public/r/NopeNopeNope/gate")).status).toBe(404);
  });
});

describe("private feedback from the gate", () => {
  it("stores a 1-3 star note on the ask, its client and its job", async () => {
    const { calls, tables } = serve();
    const res = await post(`/public/r/${TOKEN}/feedback`, { stars: 2, comment: "  The gate was left open.  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(inserts(calls, "review_feedback")).toEqual([
      { company_id: CO, client_id: ANA_ID, job_id: "job-1", review_request_id: "rr-1", stars: 2, comment: "The gate was left open." },
    ]);
    expect(tables.review_feedback).toHaveLength(1);
  });

  it("takes a second submit as the same note, not a new one", async () => {
    const { calls, tables } = serve();
    await post(`/public/r/${TOKEN}/feedback`, { stars: 1, comment: "Bad." });
    const again = await post(`/public/r/${TOKEN}/feedback`, { stars: 3, comment: "Worse." });
    expect(await again.json()).toEqual({ ok: true, already: true });
    expect(inserts(calls, "review_feedback")).toHaveLength(1);
    expect(tables.review_feedback).toHaveLength(1);
  });

  it.each([4, 5, 0, 2.5, "3"])("refuses %s stars: 4-5 belong on the review page, and only whole 1-3 stars are feedback", async (stars) => {
    const { calls } = serve();
    const res = await post(`/public/r/${TOKEN}/feedback`, { stars, comment: "Nope." });
    expect(res.status).toBe(400);
    expect(inserts(calls, "review_feedback")).toEqual([]);
  });

  it("404s feedback for a token no ask carries", async () => {
    const { calls } = serve();
    expect((await post("/public/r/NopeNopeNope/feedback", { stars: 2, comment: "Lost." })).status).toBe(404);
    expect(inserts(calls, "review_feedback")).toEqual([]);
  });
});
