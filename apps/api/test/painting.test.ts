import { getPreset } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client, as paving's
// tests use: tables of rows that eq-filter, with insert adding rows. Phase 2 also updates,
// deletes and reads single rows (products, packages, quote options), so the stand-in does those.
// One real-database rule the stand-in must keep, or the painting settings page's first bug hides
// again: the person's own client cannot SELECT companies.settings — migration
// 20261123100100_prices_and_settings_for_the_office.sql grants authenticated a column list that
// leaves settings out (it holds the money settings and secrets), so Postgres answers 42501 and
// the API turns that into "You don't have permission to do that." Code that needs the column
// reads it with the server's key (adminClient), as autopay, Square and the rest do. The update
// of the column is granted, and the trade_preset column is readable, so neither is denied here.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpcs: [] as Array<[string, unknown]>, seq: 0 }));
vi.mock("../src/lib/supabase", () => {
  const client = (kind: "user" | "admin") => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: unknown) => (state.rpcs.push([name, args]), { data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let mode: "select" | "update" | "delete" = "select";
      let patch: Row | null = null;
      let selectedCols: unknown;
      const inserted: Row[] = [];
      const denied = () => kind === "user" && table === "companies" && typeof selectedCols === "string" && /\bsettings\b/.test(selectedCols);
      const deniedError = { code: "42501", message: "permission denied for table companies" };
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const execute = (): Row[] => {
        if (inserted.length) return inserted;
        if (mode === "update" && patch) {
          const hit = rows();
          for (const row of hit) Object.assign(row, patch);
          return hit;
        }
        if (mode === "delete") {
          const gone = new Set(rows());
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !gone.has(row));
          return [];
        }
        return rows();
      };
      const doInsert = (list: Row | Row[]) => {
        for (const row of [list].flat()) {
          const full = { id: `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`, ...row };
          state.tables[table] = [...(state.tables[table] ?? []), full];
          inserted.push(full);
        }
        return builder;
      };
      const builder: Record<string, unknown> = {
        select: (cols?: unknown) => ((selectedCols = cols), builder),
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        not: () => builder,
        insert: doInsert,
        upsert: doInsert,
        update: (next: Row) => ((mode = "update"), (patch = next), builder),
        delete: () => ((mode = "delete"), builder),
        maybeSingle: () => (denied() ? Promise.resolve({ data: null, error: deniedError }) : Promise.resolve({ data: execute()[0] ?? null, error: null })),
        single: () => {
          if (denied()) return Promise.resolve({ data: null, error: deniedError });
          const hit = execute();
          return Promise.resolve(hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: "not exactly one row" } });
        },
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
          (denied() ? Promise.resolve({ data: null, error: deniedError }) : Promise.resolve({ data: execute(), error: null })).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
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
const QUOTE = "00000000-0000-4000-8000-0000000000e1";
const SVC_WALLS = "00000000-0000-4000-8000-000000000051";
const call = (companyId: string, method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer <redacted>", "X-Company-Id": companyId, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const send = (companyId: string, path: string, body?: unknown) => call(companyId, "POST", path, body);
const get = (companyId: string, path: string) => call(companyId, "GET", path);
const put = (companyId: string, path: string, body: unknown) => call(companyId, "PUT", path, body);

function company(id: string, trade_preset: string) {
  state.tables = {
    profiles: [{ user_id: "viewer", email: "pat@example.test", full_name: "Pat", phone: null }],
    memberships: [{ company_id: id, user_id: "viewer", active: true, role: "owner", role_id: null, company: { id, name: "A Business", slug: "a-business", trade_preset, timezone: "America/Chicago", currency: "USD", settings: {} } }],
    companies: [{ id, trade_preset }],
    services: [{ company_id: id, name: "Interior walls", sort: 0 }],
    custom_field_definitions: [],
    paint_products: [],
    paint_packages: [],
    quotes: [],
    quote_line_items: [],
    quote_options: [],
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

describe("painting numbers (phase 2)", () => {
  it("start at the blueprint's defaults and save per company", async () => {
    company(PAINTER, "painting");
    const res = await get(PAINTER, "/painting/settings");
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: Record<string, number> };
    expect(settings).toEqual({ subInteriorRate: 2, subExteriorRate: 5, laborRate: 80, materialMarkupPct: 30, defaultMarginPct: 30, overheadPct: 15, warrantyReservePct: 2.5 });

    const saved = await put(PAINTER, "/painting/settings", { settings: { ...settings, defaultMarginPct: 35 } });
    expect(saved.status).toBe(200);
    const again = (await (await get(PAINTER, "/painting/settings")).json()) as { settings: Record<string, number> };
    expect(again.settings.defaultMarginPct).toBe(35);
    const row = state.tables.companies.find((c) => c.id === PAINTER)!;
    expect((row.settings as { painting: { defaultMarginPct: number } }).painting.defaultMarginPct).toBe(35);
  });

  it("refuses every painting surface to a company that isn't a painting business", async () => {
    company(LANDSCAPER, "landscaping");
    const attempts = [
      get(LANDSCAPER, "/painting/settings"),
      put(LANDSCAPER, "/painting/settings", { settings: { subInteriorRate: 2, subExteriorRate: 5, laborRate: 80, materialMarkupPct: 30, defaultMarginPct: 30, overheadPct: 15, warrantyReservePct: 2.5 } }),
      get(LANDSCAPER, "/painting/products"),
      get(LANDSCAPER, "/painting/packages"),
      send(LANDSCAPER, "/painting/setup", {}),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect(state.tables.paint_products).toEqual([]);
    expect(state.tables.paint_packages).toEqual([]);
  });
});

describe("who may use painting settings (phase 2)", () => {
  const CUSTOMCO = "00000000-0000-4000-8000-0000000000c3";
  const CREWCO = "00000000-0000-4000-8000-0000000000c4";
  const ROLE_ID = "00000000-0000-4000-8000-0000000000d1";

  // A painting company where the signed-in person is a member at `role`, optionally through a
  // custom role (company_roles) carrying exactly `permissions` — the shape a real company has
  // once the owner defines roles under Settings → Roles.
  function member(id: string, role: string, role_id: string | null = null, permissions: string[] | null = null) {
    company(id, "painting");
    state.tables.memberships = [{ company_id: id, user_id: "viewer", active: true, role, role_id, company: { id, name: "A Business", slug: "a-business", trade_preset: "painting", timezone: "America/Chicago", currency: "USD", settings: {} } }];
    state.tables.company_roles = role_id ? [{ id: role_id, company_id: id, permissions }] : [];
  }

  it("refuses an office member whose custom role leaves Business setup off", async () => {
    member(CUSTOMCO, "office", ROLE_ID, ["sales", "invoices", "schedule"]);
    const attempts = [
      get(CUSTOMCO, "/painting/settings"),
      get(CUSTOMCO, "/painting/products"),
      get(CUSTOMCO, "/painting/packages"),
      send(CUSTOMCO, "/painting/setup", {}),
      send(CUSTOMCO, "/painting/products", { name: "Emerald Exterior", scope: "exterior", cost_per_gallon: 62, markup_pct: 30, coverage_per_gallon: 350 }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/don't have permission/);
    }
    expect(state.tables.paint_products).toEqual([]);
    expect(state.tables.paint_packages).toEqual([]);
  });

  it("lets an office member whose custom role includes Business setup read the page", async () => {
    member(CUSTOMCO, "office", ROLE_ID, ["sales", "settings"]);
    expect((await get(CUSTOMCO, "/painting/settings")).status).toBe(200);
    expect((await get(CUSTOMCO, "/painting/products")).status).toBe(200);
    expect((await get(CUSTOMCO, "/painting/packages")).status).toBe(200);
  });

  it("refuses a field-crew member outright", async () => {
    member(CREWCO, "field_crew");
    expect((await get(CREWCO, "/painting/settings")).status).toBe(403);
    expect((await get(CREWCO, "/painting/products")).status).toBe(403);
    expect((await send(CREWCO, "/painting/setup", {})).status).toBe(403);
  });
});

describe("painting products and packages (phase 2)", () => {
  it("seeds the blueprint's products and Josue's real packages, once", async () => {
    company(PAINTER, "painting");
    const res = await send(PAINTER, "/painting/setup", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ products_created: 4, packages_created: 12, packages_resynced: 0 });

    const { products } = (await (await get(PAINTER, "/painting/products")).json()) as { products: Array<Record<string, unknown>> };
    expect(products.find((p) => p.name === "Interior Acrylic Latex")).toMatchObject({ cost_per_gallon: 42, coverage_per_gallon: 400, markup_pct: 30 });
    expect(products.find((p) => p.name === "ProClassic Trim")).toMatchObject({ scope: "trim", cost_per_gallon: 55 });

    const { packages } = (await (await get(PAINTER, "/painting/packages")).json()) as { packages: Array<Record<string, unknown>> };
    expect(packages).toHaveLength(12);
    const t1Better = packages.find((p) => p.set_name === "Interior Painting: Standard / Premium / Ultimate" && p.tier === "better")!;
    expect(t1Better).toMatchObject({ product_name: "Sherwin-Williams Duration", product_id: null, markup_pct: 15, warranty: "3-year workmanship warranty", is_default: true });
    const extBest = packages.find((p) => p.set_name === "Exterior Painting" && p.tier === "best")!;
    expect(extBest.warranty_months).toBe(36);
    expect(extBest.warranty).toBe("3-year warranty");
    expect(extBest.product_id).toBeTruthy(); // Duration Exterior has a blueprint cost, so Best links to it.
    expect(extBest.highlights).toContain("Free annual touch-up visit");
    // Nov 27: Lead Control's exterior templates carry Emerald Rain Refresh in Better itself.
    const extBetter = packages.find((p) => p.set_name === "Exterior Painting" && p.tier === "better")!;
    expect(extBetter).toMatchObject({ product_name: "Sherwin-Williams Emerald Rain Refresh", warranty_months: 24, warranty: "2-year warranty", markup_pct: 15 });
    const extGood = packages.find((p) => p.set_name === "Exterior Painting" && p.tier === "good")!;
    expect(extGood.product_name).toBe("Sherwin-Williams SuperPaint");
    const t6Better = packages.find((p) => p.set_name === "Exterior Painting (Good)" && p.tier === "better")!;
    expect(t6Better).toMatchObject({ product_name: "Sherwin-Williams Emerald Rain Refresh", warranty_months: 24, warranty: "2-year warranty", markup_pct: 0 });
    const t5Better = packages.find((p) => String(p.set_name).includes("(Standard Package)") && p.tier === "better")!;
    expect(t5Better.is_enabled).toBe(false); // A tier Lead Control has off seeds off.

    const again = await send(PAINTER, "/painting/setup", {});
    expect(await again.json()).toEqual({ products_created: 0, packages_created: 0, packages_resynced: 0 });
  });

  it("resyncs exterior packages seeded before the Nov 27 template change, but leaves hand-edited rows alone", async () => {
    company(PAINTER, "painting");
    await send(PAINTER, "/painting/setup", {});
    // Roll the exterior rows back to what setup planted before Nov 27 (the previous seeds).
    const rows = state.tables.paint_packages;
    const find = (set: string, tier: string) => rows.find((p) => p.set_name === set && p.tier === tier)!;
    Object.assign(find("Exterior Painting", "good"), { product_name: null, highlights: ["Power wash all surfaces", "1 coat primer + 1 coat exterior paint", "Caulk gaps and cracks", "Standard prep"] });
    Object.assign(find("Exterior Painting", "better"), { product_name: "Sherwin-Williams Resilience", warranty_months: 36, warranty: "3-year warranty", highlights: ["Power wash + light scraping", "1 coat primer + 2 coats exterior paint", "Premium Sherwin-Williams Resilience", "Caulk all trim and windows"] });
    Object.assign(find("Exterior Painting", "best"), { warranty_months: 60, warranty: "5-year warranty" });
    Object.assign(find("Exterior Painting (Good)", "good"), { product_name: null, highlights: ["Power wash all surfaces", "1 coat primer + 1 coat exterior paint", "Caulk gaps and cracks", "Standard prep"] });
    Object.assign(find("Exterior Painting (Good)", "better"), { product_name: "Sherwin-Williams SuperPaint", warranty_months: 36, warranty: "3-year warranty", highlights: ["Power wash + light scraping", "2 coats exterior paint", "Sherwin-Williams — SuperPaint", "Caulk all trim and windows"] });
    Object.assign(find("Exterior Painting (Good)", "best"), { warranty_months: 60, warranty: "5-year warranty" });
    // One row was edited by hand after seeding — a different markup — so it is no longer the seed's row.
    find("Exterior Painting", "better").markup_pct = 20;

    const res = await send(PAINTER, "/painting/setup", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ products_created: 0, packages_created: 0, packages_resynced: 5 });

    // The hand-edited row kept everything, including its old product and warranty.
    expect(find("Exterior Painting", "better")).toMatchObject({ markup_pct: 20, product_name: "Sherwin-Williams Resilience", warranty_months: 36 });
    // The untouched rows moved to the Nov 27 templates.
    expect(find("Exterior Painting", "good").product_name).toBe("Sherwin-Williams SuperPaint");
    expect(find("Exterior Painting", "best")).toMatchObject({ warranty_months: 36, warranty: "3-year warranty" });
    expect(find("Exterior Painting (Good)", "better")).toMatchObject({ product_name: "Sherwin-Williams Emerald Rain Refresh", warranty_months: 24, markup_pct: 0 });
    expect(find("Exterior Painting (Good)", "best").warranty_months).toBe(36);
    // Interior rows were never part of the resync.
    expect(find("Interior Painting: Standard / Premium / Ultimate", "better").product_name).toBe("Sherwin-Williams Duration");
  });

  it("adds, changes and removes a product", async () => {
    company(PAINTER, "painting");
    const made = await send(PAINTER, "/painting/products", { name: "Emerald Exterior", scope: "exterior", cost_per_gallon: 62, markup_pct: 30, coverage_per_gallon: 350 });
    expect(made.status).toBe(201);
    const { product } = (await made.json()) as { product: { id: string } };
    const changed = await put(PAINTER, `/painting/products/${product.id}`, { name: "Emerald Exterior", scope: "exterior", cost_per_gallon: 64, markup_pct: 30, coverage_per_gallon: 350 });
    expect(changed.status).toBe(200);
    expect(state.tables.paint_products.find((p) => p.id === product.id)).toMatchObject({ cost_per_gallon: 64 });
    const removed = await call(PAINTER, "DELETE", `/painting/products/${product.id}`);
    expect(removed.status).toBe(200);
    expect(state.tables.paint_products.some((p) => p.id === product.id)).toBe(false);
  });
});

describe("offering paint packages on a proposal (phase 2)", () => {
  it("turns the proposal's lines into Hub options, repriced per tier", async () => {
    company(PAINTER, "painting");
    await send(PAINTER, "/painting/setup", {});
    state.tables.services.push({ id: SVC_WALLS, company_id: PAINTER, name: "Interior walls", category: "Interior", active: true, sort: 0 });
    state.tables.quotes.push({ id: QUOTE, company_id: PAINTER, status: "draft", option_id: null });
    state.tables.quote_line_items.push(
      { id: "line-walls", company_id: PAINTER, quote_id: QUOTE, option_id: null, service_id: SVC_WALLS, name: "Master Bedroom walls", description: null, quantity: 740, unit: "sq ft", unit_price: 3.16, unit_cost: null, material_cost: null, taxable: true, optional: false, selected: true, formula: null, sort: 0 },
      { id: "line-extra", company_id: PAINTER, quote_id: QUOTE, option_id: null, service_id: null, name: "Accent wall", description: null, quantity: 1, unit: "job", unit_price: 250, unit_cost: null, material_cost: null, taxable: true, optional: true, selected: true, formula: null, sort: 1 },
    );
    const { packages } = (await (await get(PAINTER, "/painting/packages")).json()) as { packages: Array<Record<string, unknown>> };
    const set = packages.filter((p) => p.set_name === "Interior Painting: Standard / Premium / Ultimate");
    const better = set.find((p) => p.tier === "better")!;

    const res = await send(PAINTER, `/painting/${QUOTE}/packages`, { package_ids: set.map((p) => p.id) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: Array<{ paint_package_id: string }>; default_package_id: string };
    expect(body.options).toHaveLength(3);
    expect(body.default_package_id).toBe(better.id);

    const options = state.tables.quote_options.filter((o) => o.quote_id === QUOTE);
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.paint_package_id && !("package_id" in o && o.package_id))).toBe(true);
    const betterOption = options.find((o) => o.paint_package_id === better.id)!;
    expect(state.tables.quote_line_items.find((l) => l.id === "line-walls")!.option_id).toBe(betterOption.id);
    expect(state.tables.quote_line_items.find((l) => l.id === "line-extra")!.option_id).toBeNull();
    const goodOption = options.find((o) => o.paint_package_id === set.find((p) => p.tier === "good")!.id)!;
    const goodWalls = state.tables.quote_line_items.find((l) => l.option_id === goodOption.id && l.name === "Master Bedroom walls")!;
    expect(goodWalls).toBeTruthy();
    expect(Number(goodWalls.unit_price)).not.toBe(3.16);
    expect(Number(goodWalls.unit_price)).toBeGreaterThan(0);
    const quote = state.tables.quotes.find((q) => q.id === QUOTE)!;
    expect(quote.paint_package_id).toBe(better.id);
    expect(quote.option_id).toBe(betterOption.id);

    const again = await send(PAINTER, `/painting/${QUOTE}/packages`, { package_ids: [better.id] });
    expect(again.status).toBe(409);
  });
});

describe("paint packages keep the proposal's rooms (phase 3)", () => {
  it("copies each line's room onto the other tiers' lines", async () => {
    company(PAINTER, "painting");
    await send(PAINTER, "/painting/setup", {});
    state.tables.services.push({ id: SVC_WALLS, company_id: PAINTER, name: "Exterior walls and siding", category: "Exterior", active: true, sort: 0 });
    state.tables.quotes.push({ id: QUOTE, company_id: PAINTER, status: "draft", option_id: null });
    state.tables.quote_line_items.push(
      { id: "line-brick", company_id: PAINTER, quote_id: QUOTE, option_id: null, service_id: SVC_WALLS, name: "Brick Painting", description: null, quantity: 2700, unit: "sq ft", unit_price: 1.3, unit_cost: null, material_cost: null, taxable: true, optional: false, selected: true, formula: null, sort: 0, paint_detail: { room: "Exterior", dimensions: "52' × 52' × 8'" } },
    );
    const { packages } = (await (await get(PAINTER, "/painting/packages")).json()) as { packages: Array<Record<string, unknown>> };
    const set = packages.filter((p) => p.set_name === "Exterior Painting");
    const res = await send(PAINTER, `/painting/${QUOTE}/packages`, { package_ids: set.map((p) => p.id) });
    expect(res.status).toBe(200);
    const copies = state.tables.quote_line_items.filter((l) => l.quote_id === QUOTE && l.id !== "line-brick");
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(copy.paint_detail).toEqual({ room: "Exterior", dimensions: "52' × 52' × 8'" });
  });
});
