import { describe, expect, it } from "vitest";
import {
  buildPaintArea,
  emptyPaintAreaDraft,
  paintAreaDetailFrom,
  paintAreaDraftFromLines,
  paintAreaQuantities,
  paintAreaServiceFor,
  paintDimensionsText,
  paintDetailFrom,
  paintDetailJson,
  paintPresentationFrom,
  paintRoomGroups,
  DEFAULT_PAINT_PRODUCTS,
  DEFAULT_PAINT_SETTINGS,
  docWord,
  evaluateFormula,
  isPaintingTrade,
  paintProposalMath,
  paintSettingsFrom,
  INTERIOR_SURFACES,
  PAINTING_TRADE,
  PRESETS,
  presetCustomFields,
  presetSummaries,
  presetWeatherRules,
  productSellPerGallon,
  weatherRuleSummary,
  type PaintAreaService,
  type PaintProduct,
} from "../src";

const product = (name: string): PaintProduct & { key: string } => {
  const found = DEFAULT_PAINT_PRODUCTS.find((p) => p.name === name)!;
  return { ...found, key: name };
};

describe("the painting preset", () => {
  const painting = PRESETS.painting;

  it("is registered and listed with the other trades", () => {
    expect(painting).toBeDefined();
    expect(painting.id).toBe(PAINTING_TRADE);
    expect(presetSummaries().map((p) => p.id)).toContain("painting");
  });

  it("prices its surfaces in one book, in Interior, Exterior and Prep categories", () => {
    const categories = new Set(painting.services.map((s) => s.category));
    expect(categories).toEqual(new Set(["Interior", "Exterior", "Prep and repairs"]));
    for (const name of ["Interior walls", "Ceilings", "Trim", "Baseboards, 3 in", "Baseboards, 5 in", "Window trim", "Tray ceiling", "Cabinets", "Exterior walls and siding", "Shutters", "Front door", "Pressure washing", "Drywall repair"]) {
      expect(painting.services.map((s) => s.name), name).toContain(name);
    }
    // Walls by the square foot, as a painter's production rate is.
    expect(painting.services.find((s) => s.name === "Interior walls")).toMatchObject({ unit: "sq ft", category: "Interior" });
  });

  it("gives every measured service a formula that measures something", () => {
    const formulas = new Map(painting.formulas.map((f) => [f.name, f.formula]));
    for (const s of painting.services.filter((s) => s.formula_name)) {
      expect(evaluateFormula(formulas.get(s.formula_name!)!, { area_sqft: 500, length_ft: 120 }), s.name).toBeGreaterThan(0);
    }
  });

  it("names only its own services on its checklists, in working order", () => {
    const names = new Set(painting.services.map((s) => s.name));
    for (const cl of painting.checklists) for (const name of cl.services ?? []) expect(names.has(name), `${cl.name}: ${name}`).toBe(true);
    const interior = painting.checklists.find((c) => c.name === "Paint job — interior")!;
    const keys = interior.items.map((i) => i.key);
    expect(keys.indexOf("walkthrough_colors_confirmed")).toBeLessThan(keys.indexOf("prep_done"));
    expect(keys.indexOf("prep_done")).toBeLessThan(keys.indexOf("coat_1"));
    expect(keys.indexOf("coat_2")).toBeLessThan(keys.indexOf("final_walkthrough"));
    expect(interior.items.find((i) => i.key === "final_walkthrough")?.type).toBe("signature");
    // The lead-safe checklist stands alone: it goes with any job on a pre-1978 house.
    const lead = painting.checklists.find((c) => c.name.includes("Lead-safe"))!;
    expect(lead.services).toBeUndefined();
  });

  it("starts with the color and sheen sheet as fields on quotes and jobs", () => {
    const rows = presetCustomFields(painting);
    for (const key of ["paint_color", "sheen", "product_brand", "built_before_1978"]) {
      expect(rows.filter((r) => r.key === key).map((r) => r.record_type).sort()).toEqual(["job", "quote"]);
    }
    expect(painting.custom_fields?.find((f) => f.key === "sheen")?.choices).toContain("Semi-gloss");
    expect(painting.custom_fields?.find((f) => f.key === "built_before_1978")?.type).toBe("yes_no");
  });

  it("keeps exterior paint off wet, cold, humid days", () => {
    const rules = presetWeatherRules(painting, (name) => name);
    const walls = rules.find((r) => r.applies_to === "Exterior walls and siding")!;
    expect(walls).toMatchObject({ min_temp_f: 50, requires_dry_hours: 24, max_humidity_pct: 85 });
    expect(weatherRuleSummary(walls)).toContain("humidity at most 85%");
    // Interior work has no weather rules.
    expect(rules.every((r) => (r.applies_to ?? "").startsWith("Exterior"))).toBe(true);
  });

  it("asks for a painting estimate with its own intake form", () => {
    const form = painting.intake_forms.find((f) => f.slug === "painting-estimate-request")!;
    expect(form).toMatchObject({ name: "Painting estimate request", kind: "request" });
    expect(form.questions.map((q) => q.key)).toContain("inside_or_outside");
  });
});

describe("painting's gate and its word for the document", () => {
  it("is a painting business only on the painting preset", () => {
    expect(isPaintingTrade("painting")).toBe(true);
    expect(isPaintingTrade("landscaping")).toBe(false);
    expect(isPaintingTrade("roofing_exteriors")).toBe(false);
    expect(isPaintingTrade(null)).toBe(false);
    expect(isPaintingTrade(undefined)).toBe(false);
    expect(isPaintingTrade("")).toBe(false);
  });

  it("calls the document a Proposal for painters and a Quote for everyone else", () => {
    expect(docWord("painting")).toBe("Proposal");
    expect(docWord("painting", true)).toBe("Proposals");
    expect(docWord("landscaping")).toBe("Quote");
    expect(docWord("landscaping", true)).toBe("Quotes");
    expect(docWord(null)).toBe("Quote");
    expect(docWord(undefined, true)).toBe("Quotes");
  });
});

describe("painting's numbers (from the Lead Control blueprint)", () => {
  it("starts from Ocean Crest's settings", () => {
    expect(DEFAULT_PAINT_SETTINGS).toEqual({ subInteriorRate: 2, subExteriorRate: 5, laborRate: 80, materialMarkupPct: 30, defaultMarginPct: 30, overheadPct: 15, warrantyReservePct: 2.5 });
    expect(DEFAULT_PAINT_PRODUCTS.map((p) => [p.name, p.costPerGallon, p.coveragePerGallon])).toEqual([
      ["Interior Acrylic Latex", 42, 400],
      ["Exterior Acrylic Latex", 48, 320],
      ["ProClassic Trim", 55, 350],
      ["Duration Exterior", 48, 350],
    ]);
    expect(productSellPerGallon(DEFAULT_PAINT_PRODUCTS[0]!)).toBe(54.6);
  });

  it("reads stored settings over the defaults and ignores junk", () => {
    expect(paintSettingsFrom(null)).toEqual(DEFAULT_PAINT_SETTINGS);
    expect(paintSettingsFrom("nope")).toEqual(DEFAULT_PAINT_SETTINGS);
    expect(paintSettingsFrom({ subInteriorRate: 2.25, defaultMarginPct: 24, laborRate: "80" })).toEqual({ ...DEFAULT_PAINT_SETTINGS, subInteriorRate: 2.25, defaultMarginPct: 24 });
  });
});

describe("the painting proposal math", () => {
  const settings = DEFAULT_PAINT_SETTINGS;

  it("prices an interior room the Lead Control way (PROP-0022's master bedroom shape)", () => {
    // 740 sq ft of wall (17 x 20 x 10 ft), 2 coats of Interior Acrylic Latex.
    const math = paintProposalMath([{ room: "Master Bedroom", scope: "interior", quantity: 740, coats: 2, product: product("Interior Acrylic Latex") }], settings);
    expect(math.laborCost).toBe(1480); // 740 sq ft at the $2.00 interior sub rate
    expect(math.gallonsByProduct).toEqual({ "Interior Acrylic Latex": 4 }); // 3.7 raw, rounded up for the room
    expect(math.materialCost).toBe(218.4); // 4 gal x $42 x 1.30 markup
    expect(math.directCost).toBe(1698.4);
    expect(math.overheadCost).toBe(254.76); // 15%
    expect(math.warrantyReserveCost).toBe(42.46); // 2.5%
    expect(math.totalCost).toBe(1995.62);
    expect(math.price).toBe(2850.89); // cost / (1 - 30% margin)
    expect(math.profit).toBe(855.27);
    expect(math.marginPct).toBe(30);
    expect(math.surfaces[0]!.unitPrice).toBe(3.85);
  });

  it("rounds gallons up per room, not once per job", () => {
    const walls = (room: string) => ({ room, scope: "interior" as const, quantity: 100, coats: 2, product: product("Interior Acrylic Latex") });
    const math = paintProposalMath([walls("Bedroom"), walls("Office")], settings);
    // Half a gallon raw in each room still buys a gallon for each room.
    expect(math.gallonsByProduct).toEqual({ "Interior Acrylic Latex": 2 });
    expect(math.materialCost).toBe(109.2);
    const oneRoom = paintProposalMath([{ room: "Both", scope: "interior", quantity: 200, coats: 2, product: product("Interior Acrylic Latex") }], settings);
    expect(oneRoom.gallonsByProduct).toEqual({ "Interior Acrylic Latex": 1 });
  });

  it("prices flat-fee surfaces and employee hours without paint", () => {
    const math = paintProposalMath(
      [
        { scope: "exterior", quantity: 1, flatFeePerUnit: 650 }, // a garage door
        { scope: "interior", quantity: 4, laborHoursPerUnit: 0.35 }, // window trim, employee mode
      ],
      settings,
    );
    expect(math.laborCost).toBe(650 + 4 * 0.35 * 80);
    expect(math.materialCost).toBe(0);
    expect(math.gallonsByProduct).toEqual({});
  });

  it("prices an exterior room with two products (PROP-0024's stucco room shape)", () => {
    const math = paintProposalMath(
      [
        { room: "House", scope: "exterior", quantity: 400, coats: 2, product: { ...product("Interior Acrylic Latex"), coveragePerGallon: 300 } },
        { room: "House", scope: "exterior", quantity: 70, coats: 2, product: product("Duration Exterior") },
        { room: "House", scope: "exterior", quantity: 2, flatFeePerUnit: 150 },
        { room: "House", scope: "exterior", quantity: 90, coats: 2, product: product("Interior Acrylic Latex") },
      ],
      settings,
    );
    expect(math.laborCost).toBe(2000 + 350 + 300 + 450); // every surface at the $5.00 exterior sub rate or its fee
    // Walls (textured, 300/gal) and the tray ceiling (400/gal) share a product in one room:
    // 2.67 + 0.45 raw gallons round up together to 4; the trim's 0.4 raw rounds up to 1.
    expect(math.gallonsByProduct).toEqual({ "Interior Acrylic Latex": 4, "Duration Exterior": 1 });
    expect(math.materialCost).toBe(218.4 + 62.4);
    expect(math.directCost).toBe(3100 + 280.8);
    expect(math.price).toBe(5674.91); // (direct x 1.175) / (1 - 30%)
    expect(math.marginPct).toBe(30);
  });

  it("lets the person quoting move the margin, and never divides by zero", () => {
    const input = [{ scope: "interior" as const, quantity: 100, coats: 2, product: product("Interior Acrylic Latex") }];
    const at24 = paintProposalMath(input, settings, 24);
    expect(at24.marginPct).toBe(24);
    expect(at24.price).toBeLessThan(paintProposalMath(input, settings).price);
    expect(() => paintProposalMath(input, settings, 100)).not.toThrow();
  });
});

describe("paint detail and presentation (phase 3)", () => {
  it("reads a line's room and dimensions, tolerating anything else", () => {
    expect(paintDetailFrom({ room: " Exterior ", dimensions: "52' × 52' × 8'" })).toEqual({ room: "Exterior", dimensions: "52' × 52' × 8'" });
    expect(paintDetailFrom({ room: "Kitchen" })).toEqual({ room: "Kitchen", dimensions: null });
    expect(paintDetailFrom(null)).toEqual({ room: null, dimensions: null });
    expect(paintDetailFrom("Exterior")).toEqual({ room: null, dimensions: null });
    expect(paintDetailFrom({ room: "  " })).toEqual({ room: null, dimensions: null });
    expect(paintDetailFrom([{ room: "X" }])).toEqual({ room: null, dimensions: null });
  });

  it("writes a line's room back, and nothing when the line is in no room", () => {
    expect(paintDetailJson({ room: "Exterior", dimensions: null })).toEqual({ room: "Exterior" });
    expect(paintDetailJson({ room: "Exterior", dimensions: "10 × 12" })).toEqual({ room: "Exterior", dimensions: "10 × 12" });
    expect(paintDetailJson({ room: null, dimensions: "10 × 12" })).toBeNull();
  });

  it("reads the proposal's words, keeping only real highlights", () => {
    expect(paintPresentationFrom({ scope: " Paint the brick. ", notes: "Cash job.", highlights: [" 1 coat ", "", 42, "No warranty"] })).toEqual({
      scope: "Paint the brick.",
      notes: "Cash job.",
      highlights: ["1 coat", "No warranty"],
    });
    expect(paintPresentationFrom(null)).toEqual({ scope: null, notes: null, highlights: [] });
    expect(paintPresentationFrom({ highlights: "nope" })).toEqual({ scope: null, notes: null, highlights: [] });
  });

  it("groups lines by room in first-written order, roomless lines together", () => {
    const line = (name: string, paint_detail?: unknown) => ({ name, paint_detail });
    const groups = paintRoomGroups([
      line("Walls", { room: "Master Bedroom" }),
      line("Trim"),
      line("Ceiling", { room: "Master Bedroom", dimensions: "12 × 14 × 8" }),
      line("Doors", { room: "Hallway" }),
      line("Baseboards"),
    ]);
    expect(groups.map((g) => g.room)).toEqual(["Master Bedroom", null, "Hallway"]);
    expect(groups[0]!.lines.map((l) => l.name)).toEqual(["Walls", "Ceiling"]);
    expect(groups[0]!.dimensions).toBe("12 × 14 × 8");
    expect(groups[1]!.lines.map((l) => l.name)).toEqual(["Trim", "Baseboards"]);
    expect(groups[2]!.dimensions).toBeNull();
    expect(paintRoomGroups([])).toEqual([]);
  });
});

describe("the one-screen area builder", () => {
  // The price book as the builder reads it: the preset's surfaces with ids.
  const svc = (name: string, category: string, unit: string, unit_price: number): PaintAreaService => ({
    id: `svc-${name}`,
    name,
    category,
    unit,
    unit_price,
    unit_cost: null,
    taxable: true,
  });
  const services: PaintAreaService[] = [
    svc("Interior walls", "Interior", "sq ft", 3.16),
    svc("Ceilings", "Interior", "sq ft", 3.16),
    svc("Trim", "Interior", "ft", 2.42),
    svc("Baseboards, 3 in", "Interior", "ft", 2.42),
    svc("Baseboards, 5 in", "Interior", "ft", 2.42),
    svc("Window trim", "Interior", "ea", 40),
    svc("Doors", "Interior", "ea", 85.21),
    svc("Exterior walls and siding", "Exterior", "sq ft", 7.57),
    svc("Exterior trim", "Exterior", "ft", 7.53),
    svc("Fascia", "Exterior", "ft", 4.8),
    svc("Shutters", "Exterior", "ea", 40),
    svc("Front door", "Exterior", "ea", 85.21),
    svc("Garage door", "Exterior", "ea", 928.57),
  ];
  const products = DEFAULT_PAINT_PRODUCTS.map((p) => ({ ...p, key: p.name }));
  const settings = DEFAULT_PAINT_SETTINGS;

  it("measures a room from its feet: walls, ceiling, perimeter", () => {
    expect(paintAreaQuantities({ l: 12, w: 12, h: 8 })).toEqual({ walls: 384, ceiling: 144, perimeter: 48 });
    expect(paintAreaQuantities({ l: 52, w: 52, h: 8 })).toEqual({ walls: 1664, ceiling: 2704, perimeter: 208 });
    expect(paintDimensionsText({ l: 12, w: 12, h: 8 })).toBe("12' × 12' × 8'");
  });

  it("starts an area with the measured surfaces on at two coats, the pieces off", () => {
    const draft = emptyPaintAreaDraft("interior", "Bedroom");
    expect(draft.surfaces.walls).toMatchObject({ on: true, coats: 2 });
    expect(draft.surfaces.ceiling!.on).toBe(true);
    expect(draft.surfaces.trim!.on).toBe(true);
    expect(draft.surfaces.baseboards!.on).toBe(false);
    expect(draft.surfaces.doors!.on).toBe(false);
    expect(draft.prep).toEqual({ on: false, amount: 0 });
    // A ceiling-only room starts from just its ceiling.
    const ceilingOnly = emptyPaintAreaDraft("interior", "Ceiling only");
    expect(ceilingOnly.surfaces.ceiling!.on).toBe(true);
  });

  it("builds an interior area into ordinary lines with the room on them", () => {
    const draft = emptyPaintAreaDraft("interior", "Master bedroom");
    draft.feet = { l: 12, w: 12, h: 8 };
    draft.surfaces.doors = { on: true, coats: 2, count: 2, variant: "default" };
    draft.prep = { on: true, amount: 150 };
    const built = buildPaintArea(draft, services, settings, products);
    const byName = new Map(built.lines.map((l) => [l.name, l]));
    expect(byName.get("Interior walls")).toMatchObject({ quantity: 384, unit: "sq ft", unit_price: 3.16 });
    expect(byName.get("Ceilings")).toMatchObject({ quantity: 144 });
    expect(byName.get("Trim")).toMatchObject({ quantity: 48, unit: "ft" });
    expect(byName.get("Doors")).toMatchObject({ quantity: 2, unit: "ea" });
    expect(byName.get("Prep")).toMatchObject({ quantity: 1, unit_price: 150, service_id: null });
    // The room rides on every line, with its dimensions, coats and feet for the readers.
    for (const line of built.lines) {
      expect(paintDetailFrom(line.paint_detail)).toEqual({ room: "Master bedroom", dimensions: "12' × 12' × 8'" });
    }
    expect(paintAreaDetailFrom(byName.get("Interior walls")!.paint_detail).coats).toBe(2);
    expect(paintAreaDetailFrom(byName.get("Interior walls")!.paint_detail).feet).toEqual({ l: 12, w: 12, h: 8 });
    // The room total is the lines' total, and the breakdown shows the same work.
    expect(built.roomTotal).toBeCloseTo(384 * 3.16 + 144 * 3.16 + 48 * 2.42 + 2 * 85.21 + 150, 2);
    expect(built.breakdown.find((r) => r.key === "walls")).toMatchObject({ quantity: 384, rate: 3.16, coats: 2 });
    // Gallons round up per room per product: walls + ceiling share the interior pot
    // ((384 + 144) × 2 coats ÷ 400 = 2.64 → 3); the trim drinks its own (48 × 2 ÷ 350 → 1).
    expect(built.gallonsByProduct["Interior Acrylic Latex"]).toBe(3);
    expect(built.gallonsByProduct["ProClassic Trim"]).toBe(1);
  });

  it("prices a double door as two slabs and says so on the line", () => {
    const draft = emptyPaintAreaDraft("interior", "Hallway");
    draft.feet = { l: 10, w: 4, h: 8 };
    draft.doorType = "double";
    draft.surfaces.doors = { on: true, coats: 2, count: 1, variant: "default" };
    const built = buildPaintArea(draft, services, settings, products);
    const doors = built.lines.find((l) => l.name === "Doors")!;
    expect(doors.quantity).toBe(2);
    expect(doors.description).toBe("Double door");
  });

  it("picks the baseboard size the person picked", () => {
    const draft = emptyPaintAreaDraft("interior", "Bedroom");
    draft.feet = { l: 12, w: 10, h: 8 };
    draft.surfaces.baseboards = { on: true, coats: 2, count: 1, variant: "5" };
    const built = buildPaintArea(draft, services, settings, products);
    expect(built.lines.map((l) => l.name)).toContain("Baseboards, 5 in");
    expect(built.lines.map((l) => l.name)).not.toContain("Baseboards, 3 in");
    const def = INTERIOR_SURFACES.find((d) => d.key === "baseboards")!;
    expect(paintAreaServiceFor(def, "5", services)?.name).toBe("Baseboards, 5 in");
  });

  it("builds an exterior area off the house's feet", () => {
    const draft = emptyPaintAreaDraft("exterior", "Whole house");
    draft.feet = { l: 52, w: 52, h: 8 };
    draft.surfaces.shutters = { on: true, coats: 2, count: 6, variant: "default" };
    const built = buildPaintArea(draft, services, settings, products);
    const byName = new Map(built.lines.map((l) => [l.name, l]));
    expect(byName.get("Exterior walls and siding")).toMatchObject({ quantity: 1664, unit_price: 7.57 });
    expect(byName.get("Exterior trim")).toMatchObject({ quantity: 208, unit: "ft" });
    expect(byName.get("Shutters")).toMatchObject({ quantity: 6, unit: "ea" });
    expect(built.gallonsByProduct["Exterior Acrylic Latex"]).toBe(Math.ceil((1664 * 2) / 320));
  });

  it("shows a surface whose service the company doesn't carry as missing, not broken", () => {
    const draft = emptyPaintAreaDraft("exterior", "Front");
    draft.feet = { l: 30, w: 20, h: 9 };
    draft.surfaces.fascia = { on: true, coats: 2, count: 1, variant: "default" };
    const built = buildPaintArea(draft, services.filter((s) => s.name !== "Fascia"), settings, products);
    expect(built.breakdown.find((r) => r.key === "fascia")).toMatchObject({ missing: true, total: 0 });
    expect(built.lines.map((l) => l.name)).not.toContain("Fascia");
  });

  it("writes nothing measured until the room has a size, and reads junk detail as unset", () => {
    const draft = emptyPaintAreaDraft("interior", "Bedroom");
    const built = buildPaintArea(draft, services, settings, products);
    expect(built.lines).toEqual([]);
    expect(built.breakdown.find((r) => r.key === "walls")!.quantity).toBe(0);
    expect(paintAreaDetailFrom(null)).toEqual({ coats: null, feet: null });
    expect(paintAreaDetailFrom({ coats: "2", feet: { l: -1 } })).toEqual({ coats: null, feet: null });
    expect(paintAreaDetailFrom({ coats: 3, feet: { l: 10, w: 9, h: 8 } })).toEqual({ coats: 3, feet: { l: 10, w: 9, h: 8 } });
  });

  it("reads an area back from its lines, the way it was saved", () => {
    const draft = emptyPaintAreaDraft("interior", "Master bedroom");
    draft.feet = { l: 12, w: 12, h: 8 };
    draft.doorType = "double";
    draft.surfaces.doors = { on: true, coats: 2, count: 1, variant: "default" };
    draft.surfaces.ceiling = { on: false, coats: 2, count: 1, variant: "default" };
    draft.prep = { on: true, amount: 150 };
    const built = buildPaintArea(draft, services, settings, products);
    const back = paintAreaDraftFromLines("Master bedroom", built.lines, services)!;
    expect(back).not.toBeNull();
    expect(back.scope).toBe("interior");
    expect(back.feet).toEqual({ l: 12, w: 12, h: 8 });
    expect(back.surfaces.walls!.on).toBe(true);
    expect(back.surfaces.ceiling!.on).toBe(false);
    expect(back.surfaces.trim!.on).toBe(true);
    expect(back.doorType).toBe("double");
    expect(back.surfaces.doors).toMatchObject({ on: true, count: 1 });
    expect(back.prep).toEqual({ on: true, amount: 150 });
    // Rebuilding the read-back draft writes the same lines again.
    const rebuilt = buildPaintArea(back, services, settings, products);
    expect(rebuilt.lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual(built.lines.map((l) => [l.name, l.quantity, l.unit_price]));
    expect(rebuilt.roomTotal).toBe(built.roomTotal);
  });

  it("won't read a room the builder doesn't manage", () => {
    const custom = [{ service_id: null, name: "Fix the fence too", quantity: 1, unit_price: 200, paint_detail: { room: "Yard" } }];
    expect(paintAreaDraftFromLines("Yard", custom, services)).toBeNull();
  });
});
