/**
 * Drawing on a photo (the photo editor, apps/web/src/components/PhotoEditor.tsx): the marks as
 * data, the undo history, the size the marked-up copy is saved at, and how each mark is drawn,
 * against any 2D context. Nothing here touches the page, so it's tested on its own.
 *
 * Marks are kept in the picture's own pixels (the copy that's saved), whatever size it's shown at,
 * so a line drawn on a phone and saved lands where the finger was.
 */

import { msg } from "./i18n";

export type MarkupTool = "pen" | "arrow" | "ellipse" | "box" | "text";
export type MarkupWidth = "thin" | "thick";

export const MARKUP_TOOLS: ReadonlyArray<{ tool: MarkupTool; label: string }> = [
  { tool: "pen", label: msg("Pen") },
  { tool: "arrow", label: msg("Arrow") },
  { tool: "ellipse", label: msg("Circle") },
  { tool: "box", label: msg("Box") },
  { tool: "text", label: msg("Text") },
];

/** A few colours that show on grass, roofs, concrete and sky alike. */
export const MARKUP_COLORS: ReadonlyArray<{ color: string; label: string }> = [
  { color: "#e5243b", label: msg("Red") },
  { color: "#ffd60a", label: msg("Yellow") },
  { color: "#1d6cf2", label: msg("Blue") },
  { color: "#ffffff", label: msg("White") },
  { color: "#111111", label: msg("Black") },
];

export interface Point {
  x: number;
  y: number;
}

export type Mark =
  | { kind: "pen"; color: string; width: MarkupWidth; points: Point[] }
  | { kind: "arrow" | "ellipse" | "box"; color: string; width: MarkupWidth; from: Point; to: Point }
  | { kind: "text"; color: string; width: MarkupWidth; at: Point; text: string };

/** The longest side of a marked-up copy: the same as a photo as it's uploaded (lib/files.ts compressImage). */
export const MARKUP_MAX_SIDE = 2000;

/** The size to save a picture at: never larger than it is, and its longest side at most `max`. */
export function exportSize(width: number, height: number, max = MARKUP_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The dark edge kept around the photo in the editor, in screen pixels (the stage's canvas rule in components.css says the same). */
export const STAGE_EDGE = 8;

/**
 * The size a picture is shown at so that all of it is on screen: its own shape, inside the box
 * less an edge all round, and never larger than the picture is. Null while the box isn't laid out.
 * The editor sets the canvas to this, so a tall photo on a wide screen, or a wide one on a phone
 * whose tool bar has wrapped, is never cut off.
 */
export function fitInside(picture: { width: number; height: number }, box: { width: number; height: number }, edge = STAGE_EDGE): { width: number; height: number } | null {
  const w = box.width - edge * 2;
  const h = box.height - edge * 2;
  if (!(picture.width > 0) || !(picture.height > 0) || !(w > 0) || !(h > 0)) return null;
  const scale = Math.min(1, w / picture.width, h / picture.height);
  return { width: Math.max(1, Math.floor(picture.width * scale)), height: Math.max(1, Math.floor(picture.height * scale)) };
}

/** How thick a line is in the picture's pixels: about the same on screen whatever the photo's size. */
export function strokeWidth(width: MarkupWidth, picture: { width: number; height: number }): number {
  const side = Math.max(picture.width, picture.height);
  return Math.max(width === "thick" ? 4 : 2, Math.round(side * (width === "thick" ? 0.012 : 0.005)));
}

/** Text's size in the picture's pixels: readable on a phone, bigger with the thick line. */
export function textSize(width: MarkupWidth, picture: { width: number; height: number }): number {
  const side = Math.max(picture.width, picture.height);
  return Math.max(14, Math.round(side * (width === "thick" ? 0.055 : 0.038)));
}

/** Where a point on the screen is on the picture, given where the picture is shown; kept inside it. */
export function toPicture(client: Point, shown: { left: number; top: number; width: number; height: number }, picture: { width: number; height: number }): Point {
  const x = ((client.x - shown.left) / Math.max(1, shown.width)) * picture.width;
  const y = ((client.y - shown.top) / Math.max(1, shown.height)) * picture.height;
  return { x: Math.min(picture.width, Math.max(0, x)), y: Math.min(picture.height, Math.max(0, y)) };
}

/** A pen stroke with the next point, unless it's too close to the last to matter (keeps a long stroke light). */
export function extendStroke(points: readonly Point[], next: Point, minGap = 2): Point[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < minGap) return points as Point[];
  return [...points, next];
}

/** Whether a mark is worth keeping: a shape needs some size (a tap isn't a box), words need words. A tap with the pen is a dot. */
export function keepsMark(mark: Mark, minSize = 4): boolean {
  if (mark.kind === "pen") return mark.points.length > 0;
  if (mark.kind === "text") return mark.text.trim().length > 0;
  return Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) >= minSize;
}

/** The two ends of an arrow's head, drawn back from its tip. */
export function arrowHead(from: Point, to: Point, lineWidth: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.min(Math.max(lineWidth * 4, 12), Math.hypot(to.x - from.x, to.y - from.y) * 0.6 || lineWidth * 4);
  const spread = Math.PI / 7;
  return [
    { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
    { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) },
  ];
}

// ---------------------------------------------------------------------------------------------
// Undo and redo
// ---------------------------------------------------------------------------------------------

/** The marks now, with every earlier state to go back to and every undone one to go forward to. */
export interface MarkupHistory {
  past: Mark[][];
  marks: Mark[];
  future: Mark[][];
}

export const emptyHistory = (): MarkupHistory => ({ past: [], marks: [], future: [] });

const step = (h: MarkupHistory, marks: Mark[]): MarkupHistory => ({ past: [...h.past, h.marks], marks, future: [] });

/** One more mark. One that isn't worth keeping changes nothing. */
export const addMark = (h: MarkupHistory, mark: Mark): MarkupHistory => (keepsMark(mark) ? step(h, [...h.marks, mark]) : h);

/** Every mark off at once, and back with one undo. */
export const clearMarks = (h: MarkupHistory): MarkupHistory => (h.marks.length ? step(h, []) : h);

export const canUndo = (h: MarkupHistory) => h.past.length > 0;
export const canRedo = (h: MarkupHistory) => h.future.length > 0;

export function undo(h: MarkupHistory): MarkupHistory {
  if (!canUndo(h)) return h;
  return { past: h.past.slice(0, -1), marks: h.past[h.past.length - 1]!, future: [h.marks, ...h.future] };
}

export function redo(h: MarkupHistory): MarkupHistory {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.marks], marks: h.future[0]!, future: h.future.slice(1) };
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

/** The parts of a canvas's 2D context the marks need (CanvasRenderingContext2D has them all). */
export interface MarkupContext {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textBaseline: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
}

/** A dark edge around light words and a light one around dark words, so they read on any photo. */
const edgeFor = (color: string) => (/^#(f|e|d)/i.test(color) ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)");

/** Draws one mark on a picture of this size. */
export function drawMark(ctx: MarkupContext, mark: Mark, picture: { width: number; height: number }) {
  const width = strokeWidth(mark.width, picture);
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (mark.kind === "pen") {
    const [first, ...rest] = mark.points;
    if (!first) return;
    ctx.beginPath();
    if (!rest.length) {
      ctx.arc(first.x, first.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  if (mark.kind === "text") {
    const size = textSize(mark.width, picture);
    ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, Math.round(size / 7));
    ctx.strokeStyle = edgeFor(mark.color);
    ctx.strokeText(mark.text, mark.at.x, mark.at.y);
    ctx.fillText(mark.text, mark.at.x, mark.at.y);
    return;
  }
  const { from, to } = mark;
  ctx.beginPath();
  if (mark.kind === "arrow") {
    const [left, right] = arrowHead(from, to, width);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(right.x, right.y);
  } else if (mark.kind === "ellipse") {
    ctx.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.rect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  }
  ctx.stroke();
}

/** Draws every mark, in the order they were made. */
export function drawMarks(ctx: MarkupContext, marks: readonly Mark[], picture: { width: number; height: number }) {
  for (const mark of marks) drawMark(ctx, mark, picture);
}
