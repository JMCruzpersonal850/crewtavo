/**
 * The clock at the property (settings.clock.geofence; Settings → Company → Time clock): the phone
 * notices when the person arrives at a visit's property and when they leave it, and either asks
 * them (remind) or starts and stops their clock itself (clock), as their own tap would.
 *
 * Crewtavo is a web app, so the phone only says where it is while Crewtavo is open on it: phones
 * pause a web page in the background. Everything here is pure (fixes in, what to do out) so the
 * browser part only finds the position and carries out what this decides (features/field/
 * geofence.ts). The position is compared on the phone and never kept by this; a tap it makes saves
 * where the phone was only when the company keeps that (settings.clock.record_location).
 *
 *   Arriving   Two fixes in a row inside the radius, each sure to within the radius. Dated at the
 *              first of them. A fix that isn't one of those starts the count again.
 *   Leaving    Fixes clearly outside the radius plus a margin (and outside the radius whatever the
 *              phone's error) for a few minutes, close together in time. Dated at the first fix
 *              outside of that run. Fixes in between neither confirm nor cancel it; a fix back
 *              inside cancels it; and after a gap (the phone was locked: they may have come back
 *              and worked on) the run starts again, so a stop is never dated from an old fix.
 *   Once       Each arrival is acted on once: the next needs leaving first.
 *   Taps win   A tap the person makes on a visit while there (Start, Stop, a timer, Complete) means
 *              they're running their own clock: the geofence only asks, for that visit, until they
 *              leave and come back.
 */
import { haversineM } from "./geo";

export type GeofenceMode = "off" | "remind" | "clock";

export const GEOFENCE_MODE_LABELS: Record<GeofenceMode, string> = {
  off: "Off",
  remind: "Remind the crew",
  clock: "Start and stop the clock",
};

/** One line under the setting for each choice. */
export const GEOFENCE_MODE_HINTS: Record<GeofenceMode, string> = {
  off: "The clock starts and stops only when someone taps.",
  remind: "When someone gets to a visit's property, their phone asks them to start the visit; when they leave, to complete it or stop their clock.",
  clock: "Their clock starts when they get to a visit's property and stops when they leave. They're still asked to start and complete the visit.",
};

/** Said with either choice that's on: what a web app can and can't do. */
export const GEOFENCE_NOTE = "This works while Crewtavo is open on the phone. Phones pause it in the background, so it notices once someone opens it again.";

export const GEOFENCE_RADIUS = { min: 100, max: 500, default: 200 } as const;

export interface Geofence {
  mode: GeofenceMode;
  /** Metres from the property's point. */
  radius: number;
}

/** The company's choice, from its settings. Off unless the office turned it on. */
export function geofence(settings: unknown): Geofence {
  const clock = (settings as { clock?: unknown } | null | undefined)?.clock;
  const saved = clock && typeof clock === "object" ? (clock as { geofence?: unknown }).geofence : null;
  const g = saved && typeof saved === "object" ? (saved as { mode?: unknown; radius?: unknown }) : {};
  const mode: GeofenceMode = g.mode === "remind" || g.mode === "clock" ? g.mode : "off";
  return { mode, radius: geofenceRadius(g.radius) };
}

/** A radius as saved, kept to 100 to 500 metres; 200 when it isn't a number. */
export function geofenceRadius(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return GEOFENCE_RADIUS.default;
  return Math.round(Math.min(GEOFENCE_RADIUS.max, Math.max(GEOFENCE_RADIUS.min, n)));
}

/** How far past the radius counts as gone: half the radius, at least 50 m. */
export const leaveMargin = (radius: number) => Math.max(50, radius / 2);
/** How long fixes have to stay outside before it counts as leaving. */
export const LEAVE_AFTER_MS = 3 * 60_000;
/** Two fixes further apart than this aren't "in a row": the person may have left and come back between. */
export const IN_A_ROW_MS = 10 * 60_000;

/** Where the phone was: what the browser's geolocation gives, with when (milliseconds). */
export interface Fix {
  lat: number;
  lng: number;
  /** Metres, as the phone reports it. */
  accuracy: number;
  at: number;
}

/** A visit the person is on today, at a property with a point on the map. */
export interface GeofenceSite {
  visitId: string;
  lat: number;
  lng: number;
  /** The street line, for "You're at 12 Oak St". */
  place: string;
  status: string;
}

/** What the geofence knows about one visit's property. */
export interface SiteTrack {
  where: "unknown" | "inside" | "outside";
  /** Good fixes inside in a row, and when the first of them was taken. */
  inRow: number;
  firstIn: number | null;
  /** While inside: when the first fix clearly outside, of the run of them going on now, was taken. */
  outSince: number | null;
  /** The latest fix clearly outside in that run. One much later starts the run again. (Not in what a phone kept from before this.) */
  outLast?: number | null;
  /** While inside: when they arrived, as the arrival was dated. */
  arrivedAt?: number | null;
  /** Arrived, but not put to the person yet: another visit's question at the same spot came first. */
  held?: boolean;
  /** The person tapped on this visit while there (or before the phone knew where it was). */
  tapped: boolean;
}

/** Kept on the phone between fixes (and across the page reloading), per person and day. */
export interface GeofenceState {
  /** The last fix taken, so one older or the same is skipped. */
  last: number | null;
  sites: Record<string, SiteTrack>;
}

export const emptyGeofence = (): GeofenceState => ({ last: null, sites: {} });

const fresh = (): SiteTrack => ({ where: "unknown", inRow: 0, firstIn: null, outSince: null, tapped: false });

export interface GeofenceEvent {
  kind: "arrived" | "left";
  visitId: string;
  /** When: the first fix inside, or the first fix outside. */
  at: number;
  /** The person tapped on the visit while there: their clock is theirs to run. */
  tapped: boolean;
}

const distance = (fix: Pick<Fix, "lat" | "lng">, site: Pick<GeofenceSite, "lat" | "lng">) => haversineM([fix.lng, fix.lat], [site.lng, site.lat]);

/** Whether a fix is clearly inside the radius. */
export const fixInside = (fix: Fix, site: Pick<GeofenceSite, "lat" | "lng">, radius: number) => fix.accuracy <= radius && distance(fix, site) <= radius;

/** Whether a fix is clearly outside: past the margin, and past the radius even if the phone is out by its whole error. */
export function fixOutside(fix: Fix, site: Pick<GeofenceSite, "lat" | "lng">, radius: number): boolean {
  const d = distance(fix, site);
  return d > radius + leaveMargin(radius) && d - fix.accuracy > radius;
}

const usable = (fix: Fix) => [fix.lat, fix.lng, fix.accuracy, fix.at].every(Number.isFinite) && fix.accuracy >= 0 && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180;

/**
 * One fix against each visit's property: the state after it, and the arrivals and departures it
 * confirms. A fix that's older than the last one, or makes no sense, changes nothing.
 */
export function trackFix(state: GeofenceState, fix: Fix, sites: readonly GeofenceSite[], radius: number): { state: GeofenceState; events: GeofenceEvent[] } {
  if (!usable(fix) || (state.last != null && fix.at <= state.last)) return { state, events: [] };
  const events: GeofenceEvent[] = [];
  const next: Record<string, SiteTrack> = { ...state.sites };
  for (const site of sites) {
    if (![site.lat, site.lng].every(Number.isFinite)) continue;
    const t: SiteTrack = { ...(next[site.visitId] ?? fresh()) };
    const inside = fixInside(fix, site, radius);
    const outside = fixOutside(fix, site, radius);
    if (inside) {
      // The last good fix inside was a while ago: this one starts a new run.
      const stale = t.inRow > 0 && t.firstIn != null && state.last != null && fix.at - state.last > IN_A_ROW_MS;
      if (t.inRow === 0 || stale) {
        t.inRow = 1;
        t.firstIn = fix.at;
      } else {
        t.inRow += 1;
      }
      t.outSince = null;
      t.outLast = null;
      if (t.where !== "inside" && t.inRow >= 2) {
        t.where = "inside";
        t.arrivedAt = t.firstIn ?? fix.at;
        t.held = false;
        events.push({ kind: "arrived", visitId: site.visitId, at: t.arrivedAt, tapped: t.tapped });
      }
    } else {
      t.inRow = 0;
      t.firstIn = null;
      if (outside) {
        if (t.where === "inside") {
          const lastOut = t.outLast ?? t.outSince;
          // The first fix outside, or the first in a while: the phone was locked in between, and
          // they may have come back and worked on. This one starts the run, so a departure is
          // never dated from the old fix (hours of work would come off their clock).
          if (t.outSince == null || lastOut == null || fix.at - lastOut > IN_A_ROW_MS) {
            t.outSince = fix.at;
            t.outLast = fix.at;
          } else if (fix.at - t.outSince >= LEAVE_AFTER_MS) {
            events.push({ kind: "left", visitId: site.visitId, at: t.outSince, tapped: t.tapped });
            t.where = "outside";
            t.outSince = null;
            t.outLast = null;
            t.arrivedAt = null;
            t.held = false;
            // Gone: next time they come, the geofence acts again.
            t.tapped = false;
          } else {
            t.outLast = fix.at;
          }
        } else {
          t.where = "outside";
          t.tapped = false;
        }
      }
    }
    next[site.visitId] = t;
  }
  return { state: { last: fix.at, sites: next }, events };
}

/**
 * The person tapped on these visits themselves (a status tap, or a clock tap while their clock was
 * on one of them). While they're there, or the phone doesn't know yet, the geofence leaves those
 * visits' clocks to them until they leave and come back. A tap made on the way there changes nothing:
 * arriving is coming back.
 */
export function noteTap(state: GeofenceState, visitIds: readonly string[]): GeofenceState {
  const sites = { ...state.sites };
  for (const id of visitIds) {
    const t = sites[id] ?? fresh();
    if (t.where !== "outside") sites[id] = { ...t, tapped: true };
  }
  return { ...state, sites };
}

/** Forgets visits that aren't today's any more (finished days, a visit moved off today). */
export function keepSites(state: GeofenceState, visitIds: readonly string[]): GeofenceState {
  const keep = new Set(visitIds);
  return { ...state, sites: Object.fromEntries(Object.entries(state.sites).filter(([id]) => keep.has(id))) };
}

/** What the person's clock is on now, as the clock card shows it (with taps still waiting). */
export interface ClockNow {
  category: string;
  visitId: string | null;
}

export type GeofenceAction =
  /** Start their clock on the visit, dated `at`, as the clock card's tap would. */
  | { kind: "start-clock"; visitId: string; at: number }
  /** Stop their clock on the visit, dated `at`; on the whole-day clock, onto travel instead. */
  | { kind: "stop-clock"; visitId: string; at: number; travel: boolean }
  /** "You're at 12 Oak St. Start the visit?" (or, with the visit under way, "Start your clock?"). */
  | { kind: "ask-start"; visitId: string; clockOnly: boolean }
  /** "Leaving 12 Oak St. Complete the visit, or stop your clock?": either part, as it applies. */
  | { kind: "ask-finish"; visitId: string; complete: boolean; stopClock: boolean };

export interface ActionContext {
  mode: GeofenceMode;
  sites: readonly GeofenceSite[];
  clock: ClockNow | null;
  /** On the whole-day clock: leaving moves the clock to travel instead of stopping it. */
  day: boolean;
}

const DONE = new Set(["completed", "cancelled"]);
const NOT_STARTED = new Set(["scheduled", "en_route"]);
/** Which visit to act on when two properties are the same (two visits at one address): the one under way, else on its way, else the first in the day's order. */
const RANK: Record<string, number> = { in_progress: 0, en_route: 1, scheduled: 2 };

/**
 * What to do about what a fix confirmed. Never twice for one arrival (trackFix sees to that), never
 * a clock on a finished or cancelled visit or over a break, never against a tap the person made
 * there, and never finishing a visit: that, and starting one (which can text the client), is always
 * the person's tap.
 */
export function geofenceActions(events: readonly GeofenceEvent[], ctx: ActionContext): GeofenceAction[] {
  if (ctx.mode === "off") return [];
  const site = (id: string) => ctx.sites.find((s) => s.visitId === id);
  const actions: GeofenceAction[] = [];
  let clock = ctx.clock;

  // Leaving first: a fix can show them gone from one property and at the next.
  for (const e of events.filter((x) => x.kind === "left")) {
    const s = site(e.visitId);
    if (!s || DONE.has(s.status)) continue;
    const clockOn = clock?.visitId === e.visitId;
    const stops = ctx.mode === "clock" && !e.tapped && clockOn;
    if (stops) {
      actions.push({ kind: "stop-clock", visitId: e.visitId, at: e.at, travel: ctx.day });
      clock = ctx.day ? { category: "drive", visitId: null } : null;
    }
    const complete = s.status === "in_progress";
    const stopClock = clockOn && !stops;
    if (complete || stopClock) actions.push({ kind: "ask-finish", visitId: e.visitId, complete, stopClock });
  }

  const arrivals = events
    .filter((x) => x.kind === "arrived")
    .map((e) => ({ e, s: site(e.visitId) }))
    .filter((x): x is { e: GeofenceEvent; s: GeofenceSite } => Boolean(x.s) && !DONE.has(x.s!.status))
    .sort((a, b) => (RANK[a.s.status] ?? 3) - (RANK[b.s.status] ?? 3) || ctx.sites.indexOf(a.s) - ctx.sites.indexOf(b.s));
  const first = arrivals[0];
  if (first) {
    const { e, s } = first;
    const clockOn = clock?.visitId === e.visitId;
    const starts = ctx.mode === "clock" && !e.tapped && !clockOn && clock?.category !== "break";
    if (starts) actions.push({ kind: "start-clock", visitId: e.visitId, at: e.at });
    if (NOT_STARTED.has(s.status)) actions.push({ kind: "ask-start", visitId: e.visitId, clockOnly: false });
    else if (!clockOn && !starts) actions.push({ kind: "ask-start", visitId: e.visitId, clockOnly: true });
  }
  return actions;
}

/**
 * How soon to look again, and how hard: often and with GPS near a property or while an arrival or a
 * departure is being confirmed, rarely and roughly far from all of them, to spare the battery.
 */
export function nextLook(state: GeofenceState, fix: Fix | null, sites: readonly GeofenceSite[], radius: number): { delayMs: number; precise: boolean } {
  const open = sites.filter((s) => !DONE.has(s.status));
  const busy = open.some((s) => {
    const t = state.sites[s.visitId];
    return t && ((t.inRow > 0 && t.where !== "inside") || t.outSince != null);
  });
  if (!fix || busy) return { delayMs: 20_000, precise: true };
  const nearest = Math.min(...open.map((s) => distance(fix, s)));
  if (nearest <= Math.max(1_500, radius * 5) || open.some((s) => state.sites[s.visitId]?.where === "inside")) return { delayMs: 30_000, precise: true };
  if (nearest <= 8_000) return { delayMs: 60_000, precise: true };
  return { delayMs: 120_000, precise: false };
}
