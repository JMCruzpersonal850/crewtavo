import { describe, expect, it } from "vitest";
import { docWord, evaluateFormula, isPaintingTrade, PAINTING_TRADE, PRESETS, presetCustomFields, presetSummaries, presetWeatherRules, weatherRuleSummary } from "../src";

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
