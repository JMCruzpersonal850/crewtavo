import { describe, expect, it } from "vitest";
import {
  addMark,
  arrowHead,
  canRedo,
  canUndo,
  clearMarks,
  drawMark,
  drawMarks,
  emptyHistory,
  exportSize,
  extendStroke,
  fitInside,
  keepsMark,
  MARKUP_COLORS,
  MARKUP_MAX_SIDE,
  MARKUP_TOOLS,
  redo,
  strokeWidth,
  textSize,
  toPicture,
  undo,
  type Mark,
  type MarkupContext,
} from "../src/photoMarkup";

const red = MARKUP_COLORS[0]!.color;
const box = (x: number): Mark => ({ kind: "box", color: red, width: "thin", from: { x, y: x }, to: { x: x + 50, y: x + 40 } });

/** A 2D context that writes down what it was asked to draw. */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => (name in target ? target[name] : (...args: number[]) => void calls.push(`${name}(${args.map((a) => (typeof a === "number" ? Math.round(a * 10) / 10 : a)).join(",")})`)),
    set: (target, name: string, value) => {
      target[name] = value;
      calls.push(`${name}=${value}`);
      return true;
    },
  });
  return { ctx: ctx as unknown as MarkupContext, calls };
}

describe("the tools and colours", () => {
  it("are a pen, an arrow, a circle, a box and text, in a few colours", () => {
    expect(MARKUP_TOOLS.map((t) => t.label)).toEqual(["Pen", "Arrow", "Circle", "Box", "Text"]);
    expect(MARKUP_COLORS.map((c) => c.label)).toEqual(["Red", "Yellow", "Blue", "White", "Black"]);
  });
});

describe("the size a marked-up copy is saved at", () => {
  it("is never larger than the photo", () => {
    expect(exportSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(exportSize(1, 1)).toEqual({ width: 1, height: 1 });
  });

  it("caps the longest side as an upload does, keeping the shape", () => {
    expect(MARKUP_MAX_SIDE).toBe(2000);
    expect(exportSize(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(exportSize(3024, 4032)).toEqual({ width: 1500, height: 2000 });
    expect(exportSize(8000, 100)).toEqual({ width: 2000, height: 25 });
    expect(exportSize(1200, 900, 600)).toEqual({ width: 600, height: 450 });
  });

  it("is at least a pixel, even for a picture that couldn't be read", () => {
    expect(exportSize(0, 0)).toEqual({ width: 1, height: 1 });
    expect(exportSize(Number.NaN, 300)).toEqual({ width: 1, height: 1 });
    expect(exportSize(10_000, 1)).toEqual({ width: 2000, height: 1 });
  });
});

describe("the size the photo is shown at in the editor", () => {
  // What the bars leave on each screen (measured: a 60 px title bar, a tool bar of 60 px on a desktop
  // and 112 px wrapped to two rows on a phone, 160 px with the words box, and a 56 px bar of buttons).
  const DESKTOP = { width: 1280, height: 624 };
  const PHONE = { width: 390, height: 439 };
  const PHONE_WORDS = { width: 390, height: 391 };
  const PHONE_SIDEWAYS = { width: 667, height: 166 };
  const LANDSCAPE = { width: 2000, height: 1500 };
  const PORTRAIT = { width: 1500, height: 2000 };

  it("is all of the photo, inside the stage less its edge, on a desktop and on a phone", () => {
    expect(fitInside(LANDSCAPE, DESKTOP)).toEqual({ width: 810, height: 608 });
    expect(fitInside(PORTRAIT, DESKTOP)).toEqual({ width: 456, height: 608 });
    expect(fitInside(LANDSCAPE, PHONE)).toEqual({ width: 374, height: 280 });
    expect(fitInside(PORTRAIT, PHONE)).toEqual({ width: 317, height: 423 });
  });

  it("never comes out taller or wider than the room, whatever the photo's shape and however much the bars take", () => {
    for (const box of [DESKTOP, PHONE, PHONE_WORDS, PHONE_SIDEWAYS, { width: 320, height: 300 }]) {
      for (const picture of [LANDSCAPE, PORTRAIT, { width: 2000, height: 900 }, { width: 300, height: 2000 }, { width: 640, height: 480 }]) {
        const shown = fitInside(picture, box)!;
        expect(shown.width).toBeLessThanOrEqual(box.width - 16);
        expect(shown.height).toBeLessThanOrEqual(box.height - 16);
        // Its own shape, to within the pixel it's rounded down to.
        expect(Math.abs(shown.width / shown.height - picture.width / picture.height)).toBeLessThan(0.05);
      }
    }
  });

  it("gets smaller when the tool bar takes another row", () => {
    expect(fitInside(PORTRAIT, PHONE_WORDS)).toEqual({ width: 281, height: 375 });
  });

  it("is never larger than the photo itself", () => {
    expect(fitInside({ width: 640, height: 480 }, DESKTOP)).toEqual({ width: 640, height: 480 });
  });

  it("waits for the stage to be laid out", () => {
    expect(fitInside(LANDSCAPE, { width: 0, height: 0 })).toBeNull();
    expect(fitInside(LANDSCAPE, { width: 16, height: 400 })).toBeNull();
    expect(fitInside({ width: 0, height: 0 }, DESKTOP)).toBeNull();
  });
});

describe("lines and words", () => {
  it("are as thick on screen whatever the photo's size, with a floor for tiny ones", () => {
    expect(strokeWidth("thin", { width: 2000, height: 1500 })).toBe(10);
    expect(strokeWidth("thick", { width: 2000, height: 1500 })).toBe(24);
    expect(strokeWidth("thin", { width: 1000, height: 750 })).toBe(5);
    expect(strokeWidth("thin", { width: 100, height: 80 })).toBe(2);
    expect(strokeWidth("thick", { width: 100, height: 80 })).toBe(4);
    expect(textSize("thin", { width: 2000, height: 1500 })).toBe(76);
    expect(textSize("thick", { width: 2000, height: 1500 })).toBe(110);
    expect(textSize("thin", { width: 120, height: 90 })).toBe(14);
  });
});

describe("where a finger is on the picture", () => {
  const shown = { left: 10, top: 100, width: 500, height: 375 };
  const picture = { width: 2000, height: 1500 };

  it("maps from the screen to the picture's own pixels", () => {
    expect(toPicture({ x: 10, y: 100 }, shown, picture)).toEqual({ x: 0, y: 0 });
    expect(toPicture({ x: 260, y: 287.5 }, shown, picture)).toEqual({ x: 1000, y: 750 });
    expect(toPicture({ x: 510, y: 475 }, shown, picture)).toEqual({ x: 2000, y: 1500 });
  });

  it("keeps a stroke that runs off the edge on the picture", () => {
    expect(toPicture({ x: -50, y: 900 }, shown, picture)).toEqual({ x: 0, y: 1500 });
  });

  it("copes with a picture not laid out yet", () => {
    expect(toPicture({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, picture)).toEqual({ x: 2000, y: 1500 });
  });
});

describe("a pen stroke", () => {
  it("skips points too close to the last to matter", () => {
    let points = extendStroke([], { x: 0, y: 0 });
    points = extendStroke(points, { x: 1, y: 1 });
    points = extendStroke(points, { x: 5, y: 0 });
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  });
});

describe("what's worth keeping", () => {
  it("is a shape with some size, words that aren't blank, and any pen mark (a tap is a dot)", () => {
    expect(keepsMark(box(10))).toBe(true);
    expect(keepsMark({ kind: "arrow", color: red, width: "thin", from: { x: 5, y: 5 }, to: { x: 6, y: 6 } })).toBe(false);
    expect(keepsMark({ kind: "ellipse", color: red, width: "thin", from: { x: 5, y: 5 }, to: { x: 5, y: 5 } })).toBe(false);
    expect(keepsMark({ kind: "text", color: red, width: "thin", at: { x: 5, y: 5 }, text: "  " })).toBe(false);
    expect(keepsMark({ kind: "text", color: red, width: "thin", at: { x: 5, y: 5 }, text: "Crack" })).toBe(true);
    expect(keepsMark({ kind: "pen", color: red, width: "thin", points: [{ x: 1, y: 1 }] })).toBe(true);
    expect(keepsMark({ kind: "pen", color: red, width: "thin", points: [] })).toBe(false);
  });
});

describe("undo and redo", () => {
  it("goes back and forward a mark at a time", () => {
    let h = addMark(addMark(emptyHistory(), box(1)), box(2));
    expect(h.marks).toEqual([box(1), box(2)]);
    expect([canUndo(h), canRedo(h)]).toEqual([true, false]);
    h = undo(h);
    expect(h.marks).toEqual([box(1)]);
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    expect(h.marks).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.marks).toEqual([box(1), box(2)]);
    expect(redo(h)).toBe(h);
  });

  it("forgets what was undone once something new is drawn", () => {
    const h = addMark(undo(addMark(addMark(emptyHistory(), box(1)), box(2))), box(3));
    expect(h.marks).toEqual([box(1), box(3)]);
    expect(canRedo(h)).toBe(false);
  });

  it("takes everything off with Clear, and puts it back with one undo", () => {
    const h = clearMarks(addMark(addMark(emptyHistory(), box(1)), box(2)));
    expect(h.marks).toEqual([]);
    expect(undo(h).marks).toEqual([box(1), box(2)]);
    // Nothing to clear: no step to undo.
    expect(clearMarks(emptyHistory())).toEqual(emptyHistory());
  });

  it("doesn't count a mark that isn't worth keeping as a step", () => {
    const h = addMark(emptyHistory(), { kind: "box", color: red, width: "thin", from: { x: 1, y: 1 }, to: { x: 1, y: 1 } });
    expect(h).toEqual(emptyHistory());
  });
});

describe("drawing", () => {
  const picture = { width: 1000, height: 750 };

  it("draws a box, a circle and an arrow in the mark's colour and width", () => {
    const { ctx, calls } = recorder();
    drawMark(ctx, { kind: "box", color: red, width: "thick", from: { x: 300, y: 200 }, to: { x: 100, y: 50 } }, picture);
    expect(calls).toEqual([`strokeStyle=${red}`, `fillStyle=${red}`, "lineWidth=12", "lineCap=round", "lineJoin=round", "beginPath()", "rect(100,50,200,150)", "stroke()"]);
    const circle = recorder();
    drawMark(circle.ctx, { kind: "ellipse", color: red, width: "thin", from: { x: 100, y: 100 }, to: { x: 300, y: 200 } }, picture);
    expect(circle.calls).toContain(`ellipse(200,150,100,50,0,0,${Math.round(Math.PI * 20) / 10})`);
    const arrow = recorder();
    drawMark(arrow.ctx, { kind: "arrow", color: red, width: "thin", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }, picture);
    expect(arrow.calls.filter((c) => c.startsWith("moveTo") || c.startsWith("lineTo"))).toEqual(["moveTo(0,0)", "lineTo(100,0)", "moveTo(82,8.7)", "lineTo(100,0)", "lineTo(82,-8.7)"]);
  });

  it("draws a pen stroke through its points, and a tap as a dot", () => {
    const { ctx, calls } = recorder();
    drawMark(ctx, { kind: "pen", color: red, width: "thin", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }, picture);
    expect(calls.slice(-5)).toEqual(["beginPath()", "moveTo(1,2)", "lineTo(3,4)", "lineTo(5,6)", "stroke()"]);
    const dot = recorder();
    drawMark(dot.ctx, { kind: "pen", color: red, width: "thin", points: [{ x: 7, y: 8 }] }, picture);
    expect(dot.calls.slice(-3)).toEqual([`beginPath()`, `arc(7,8,2.5,0,${Math.round(Math.PI * 20) / 10})`, "fill()"]);
  });

  it("writes words with an edge so they read on a light or a dark photo", () => {
    const { ctx, calls } = recorder();
    drawMark(ctx, { kind: "text", color: "#ffffff", width: "thin", at: { x: 40, y: 60 }, text: "Crack here" }, picture);
    expect(calls).toContain("strokeStyle=rgba(0,0,0,0.75)");
    expect(calls.slice(-2)).toEqual(["strokeText(Crack here,40,60)", "fillText(Crack here,40,60)"]);
    expect(calls.find((c) => c.startsWith("font="))).toBe('font=700 38px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
    const dark = recorder();
    drawMark(dark.ctx, { kind: "text", color: "#111111", width: "thin", at: { x: 1, y: 1 }, text: "Gas meter" }, picture);
    expect(dark.calls).toContain("strokeStyle=rgba(255,255,255,0.85)");
  });

  it("draws every mark in the order it was made", () => {
    const { ctx, calls } = recorder();
    drawMarks(ctx, [box(10), box(20)], picture);
    expect(calls.filter((c) => c.startsWith("rect"))).toEqual(["rect(10,10,50,40)", "rect(20,20,50,40)"]);
  });

  it("points an arrow's head back from its tip, shorter on a short arrow", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 0, y: 100 }, 5);
    expect(a.y).toBeLessThan(100);
    expect(b.y).toBeLessThan(100);
    expect(a.x + b.x).toBeCloseTo(0, 5);
    const [short] = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(Math.hypot(10 - short.x, short.y)).toBeCloseTo(6, 5);
  });
});
