import { getPreset } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client, as paving's
// tests use: tables of rows that eq-filter, with insert adding rows.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpcs: [] as Array<[string, unknown]> }));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: unknown) => (state.rpcs.push([name, args]), { data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const add = (list: Row | Row[]) => {
        state.tables[table] = [...(state.tables[table] ?? []), ...[list].flat()];
        return Promise.resolve({ data: null, error: null });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        not: () => builder,
        insert: add,
        upsert: add,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;
const PAINTER = "00000000-0000-4000-8000-0000000000c1";
const LANDSCAPER = "00000000-0000-4000-8000-0000000000c2";
const send = (companyId: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method: "POST", headers: { Authorization: "Bearer <redacted>", "X-Company-Id": companyId, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }, env);

function company(id: string, trade_preset: string) {
  state.tables = {
    profiles: [{ user_id: "viewer", email: "pat@example.test", full_name: "Pat", phone: null }],
    memberships: [{ company_id: id, user_id: "viewer", active: true, role: "owner", role_id: null, company: { id, name: "A Business", slug: "a-business", trade_preset, timezone: "America/Chicago", currency: "USD", settings: {} } }],
    companies: [{ id, trade_preset }],
    services: [{ company_id: id, name: "Interior walls", sort: 0 }],
    custom_field_definitions: [],
  };
}

afterEach(() => {
  state.tables = {};
  state.rpcs = [];
});

describe("painting back-fill", () => {
  it("adds the painting services and fields a painting company is missing", async () => {
    company(PAINTER, "painting");
    const res = await send(PAINTER, "/painting/services", {});
    expect(res.status).toBe(200);
    const { added, fields } = (await res.json()) as { added: string[]; fields: string[] };
    const standard = getPreset("painting").services.map((s) => s.name);
    expect(added).toEqual(standard.filter((name) => name !== "Interior walls"));
    expect(fields).toEqual(expect.arrayContaining(["Paint color (name and code)", "Sheen", "Product / brand", "Built before 1978 — lead-safe"]));
    expect(state.tables.services.find((s) => s.name === "Exterior walls and siding")).toMatchObject({ unit: "sq ft", category: "Exterior", formula: "area_sqft" });
    // Once more adds nothing: what's there is left alone.
    const again = await send(PAINTER, "/painting/services", {});
    expect(((await again.json()) as { added: string[] }).added).toEqual([]);
  });

  it("gives a landscaping company nothing, and says why", async () => {
    company(LANDSCAPER, "landscaping");
    const res = await send(LANDSCAPER, "/painting/services", {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/only for a painting business/);
    expect(state.tables.services).toEqual([{ company_id: LANDSCAPER, name: "Interior walls", sort: 0 }]);
    expect(state.tables.custom_field_definitions).toEqual([]);
  });
});
