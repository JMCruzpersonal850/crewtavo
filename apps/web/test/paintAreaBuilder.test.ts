/**
 * The one-screen area builder's reading of a quote's lines (quotes/PaintAreaBuilder.tsx):
 * the areas a saved proposal opens with — one card per room the builder manages, read back
 * through core's round-trip — the signature that decides when the screen re-reads the lines
 * under it, and the wiring that mounts the card for painting companies only, on the lines
 * view, with the math panel honoring the coats an area was built with.
 */
import {
  buildPaintArea,
  emptyPaintAreaDraft,
  DEFAULT_PAINT_PRODUCTS,
  DEFAULT_PAINT_SETTINGS,
  type PaintAreaService,
} from "@crewtavo/core/painting";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linesSignature, sessionsFromLines, type AreaLine } from "../src/features/quotes/PaintAreaBuilder";

// The price book as the builder reads it: the preset's surfaces with ids (core's fixtures).
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

let lineSeq = 0;
/** An area draft built the way the card's Save builds it, as the page's lines. */
const areaLines = (draft: Parameters<typeof buildPaintArea>[0]): AreaLine[] =>
  buildPaintArea(draft, services, DEFAULT_PAINT_SETTINGS, products).lines.map((l) => ({
    id: `line-${++lineSeq}`,
    service_id: l.service_id,
    name: l.name,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    option_id: null,
    sort: lineSeq,
    paint_detail: l.paint_detail,
  }));

const bedroom = () => {
  const draft = emptyPaintAreaDraft("interior", "Master bedroom");
  draft.feet = { l: 12, w: 12, h: 8 };
  draft.surfaces.doors = { on: true, coats: 2, count: 2, variant: "default" };
  draft.prep = { on: true, amount: 150 };
  return draft;
};
const wholeHouse = () => {
  const draft = emptyPaintAreaDraft("exterior", "Whole house");
  draft.feet = { l: 52, w: 52, h: 8 };
  draft.surfaces.shutters = { on: true, coats: 2, count: 6, variant: "default" };
  return draft;
};

describe("the areas a saved proposal opens with", () => {
  it("opens one card per managed room, in line order, with the draft it was saved as", () => {
    const lines = [...areaLines(bedroom()), ...areaLines(wholeHouse())];
    const sessions = sessionsFromLines(lines, services);
    expect(sessions.map((s) => s.originalRoom)).toEqual(["Master bedroom", "Whole house"]);

    const bed = sessions[0]!.draft;
    expect(bed.scope).toBe("interior");
    expect(bed.feet).toEqual({ l: 12, w: 12, h: 8 });
    expect(bed.surfaces.walls).toMatchObject({ on: true, coats: 2 });
    expect(bed.surfaces.doors).toMatchObject({ on: true, count: 2 });
    expect(bed.prep).toEqual({ on: true, amount: 150 });

    const house = sessions[1]!.draft;
    expect(house.scope).toBe("exterior");
    expect(house.feet).toEqual({ l: 52, w: 52, h: 8 });
    expect(house.surfaces.extWalls).toMatchObject({ on: true, coats: 2 });
    expect(house.surfaces.shutters).toMatchObject({ on: true, count: 6 });
    expect(house.surfaces.garageDoor!.on).toBe(false);
  });

  it("leaves rooms the builder doesn't manage — and option lines — out of the cards", () => {
    const lines = areaLines(bedroom());
    // A custom line in the same room rides along without breaking its card.
    lines.push({ id: "custom-1", service_id: null, name: "Hang the mirror", description: null, quantity: 1, unit_price: 75, option_id: null, sort: 99, paint_detail: { room: "Master bedroom" } });
    // A room holding only a hand-added line has no card: the builder never touches it.
    lines.push({ id: "custom-2", service_id: null, name: "Haul away debris", description: null, quantity: 1, unit_price: 120, option_id: null, sort: 100, paint_detail: { room: "Garage" } });
    // An option's copy of a room belongs to the options, not the base lines' cards.
    lines.push({ id: "opt-1", service_id: "svc-Interior walls", name: "Interior walls", description: null, quantity: 384, unit_price: 3.16, option_id: "option-1", sort: 101, paint_detail: { room: "Guest room", dimensions: "12' × 12' × 8'" } });

    expect(sessionsFromLines(lines, services).map((s) => s.originalRoom)).toEqual(["Master bedroom"]);
  });
});

describe("the signature the screen re-reads the lines by", () => {
  it("is stable across a fresh array of the same lines", () => {
    const lines = [...areaLines(bedroom()), ...areaLines(wholeHouse())];
    expect(linesSignature(lines, services)).toBe(linesSignature([...lines], services));
  });

  it("changes when a managed line arrives, leaves, or moves rooms — not when a custom line does", () => {
    const lines = areaLines(bedroom());
    const before = linesSignature(lines, services);

    const custom: AreaLine = { id: "custom-9", service_id: null, name: "Touch up the mailbox", description: null, quantity: 1, unit_price: 50, option_id: null, sort: 200, paint_detail: { room: "Master bedroom" } };
    expect(linesSignature([...lines, custom], services)).toBe(before);

    const managed = areaLines(wholeHouse());
    expect(linesSignature([...lines, ...managed], services)).not.toBe(before);
    expect(linesSignature(lines.slice(1), services)).not.toBe(before);

    const moved = lines.map((l, i) => (i === 0 ? { ...l, paint_detail: { ...(l.paint_detail as object), room: "Other room" } } : l));
    expect(linesSignature(moved, services)).not.toBe(before);
  });
});

describe("the wiring on the quote page", () => {
  const src = (path: string) => readFileSync(join(__dirname, "../src/features/quotes", path), "utf8");

  it("mounts the area builder for painting companies on the lines view, never on templates", () => {
    const page = src("QuotePage.tsx");
    expect(page).toContain("<PaintAreaBuilder");
    expect(page).toContain('isPaintingTrade(session.company.trade_preset) && canSell && !isTemplate && view === "lines"');
  });

  it("prices the math panel's gallons with the coats an area was built with", () => {
    expect(src("PaintMathPanel.tsx")).toContain("paintAreaDetailFrom(line.paint_detail).coats ?? coats");
  });

  it("saves an area by replacing only its managed lines, and says packages own the lines once offered", () => {
    const builder = src("PaintAreaBuilder.tsx");
    expect(builder).toContain("buildPaintArea(session.draft, services, settings!, products)");
    expect(builder).toContain("isPaintPrepLine(l)");
    expect(builder).toContain("l.option_id === null");
    expect(builder).toContain("This proposal is offered as packages");
  });
});
