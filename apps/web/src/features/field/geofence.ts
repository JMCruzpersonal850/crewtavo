/**
 * The clock at the property, on the phone (Settings → Company → Time clock → At the property).
 * packages/core/src/geofence.ts decides everything; this part finds where the phone is, keeps what
 * the geofence knows between looks, and carries out what it decides:
 *
 *   - Only while My day or a visit's screen is open, for someone whose hours the company keeps,
 *     while they have a visit today with a point on the map that isn't finished. A web page can't
 *     watch the position in the background: phones pause it, and it catches up when it's opened.
 *   - It looks every half minute or so near a property, less often and less precisely far away.
 *   - The position stays on the phone. A clock the geofence starts or stops goes through the same
 *     offline-safe tap as the clock card's (clockTaps.ts, fieldActions.setClock), marked as the
 *     geofence's, and carries where the phone was only when the company keeps that.
 *   - What it asks ("You're at 12 Oak St. Start the visit?") waits on the screen (GeofenceCard),
 *     with a buzz, and as a phone notification for someone who allowed Crewtavo's notifications.
 *   - A clock tap the person makes on a visit while there (the clock card, the crew clock) takes
 *     that visit's clock off the geofence until they leave and come back (core noteTap).
 *
 * What it knows is kept on the phone per person and day (localStorage), so a page reloaded at the
 * property doesn't take it for a new arrival.
 */
import {
  emptyGeofence,
  geofence as geofenceSetting,
  geofenceActions,
  keepSites,
  nextLook,
  noteTap,
  trackFix,
  type Fix,
  type GeofenceAction,
  type GeofenceSite,
  type GeofenceState,
} from "@crewtavo/core/geofence";
import { onlineManager, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { todayIn } from "@/lib/format";
import { FIELD_SCOPE } from "@/lib/offline";
import { keepsTime, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { clockChange, showClockTap, type ClockChange, type ClockTarget, type ShownClock } from "./clockTaps";
import { onDayClock, recordsPlaces, useRunningTimer, type ClockPlace } from "./fieldData";
import { useMyDay, type MyDayVisit } from "./myDay";

// ---------------------------------------------------------------------------------------------
// What the geofence asks, waiting on the screen
// ---------------------------------------------------------------------------------------------

export interface GeofencePrompt {
  /** One question at a time per visit and kind. */
  id: string;
  kind: "start" | "finish";
  visitId: string;
  jobId: string | null;
  title: string;
  /** The street line: "12 Oak St". */
  place: string;
  /** Start: the visit is under way already, so only their clock is offered. */
  clockOnly?: boolean;
  /** Finish: the visit is in progress, so Complete visit is offered. */
  complete?: boolean;
  /** Finish: their clock is still on the visit, so stopping it is offered. */
  stopClock?: boolean;
  /** What the phone did already: "Clock started at 12 Oak St". */
  done?: string;
}

let prompts: readonly GeofencePrompt[] = [];
const listeners = new Set<() => void>();
const setPrompts = (next: readonly GeofencePrompt[]) => {
  prompts = next;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useGeofencePrompts = () => useSyncExternalStore(subscribe, () => prompts);
export const dismissPrompt = (id: string) => setPrompts(prompts.filter((p) => p.id !== id));
/** A new question replaces one about the same visit (arriving again, then leaving). */
const ask = (prompt: GeofencePrompt) => setPrompts([...prompts.filter((p) => p.visitId !== prompt.visitId), prompt]);

/** The question as one line, for the card and the phone's notification. */
export function promptText(p: GeofencePrompt): { title: string; question: string } {
  if (p.kind === "start") return { title: `You're at ${p.place}`, question: p.clockOnly ? "Start your clock?" : "Start the visit?" };
  const question = p.complete && p.stopClock ? "Complete the visit, or stop your clock?" : p.complete ? "Complete the visit?" : "Stop your clock?";
  return { title: `Leaving ${p.place}`, question };
}

/** Whether a question still means anything, now the visit and the clock are as they are. */
export function promptStands(p: GeofencePrompt, status: string | undefined, clock: Pick<ShownClock, "visit"> | null | undefined): boolean {
  if (!status || status === "completed" || status === "cancelled") return false;
  const onIt = clock?.visit?.id === p.visitId;
  if (p.kind === "start") return p.clockOnly ? !onIt : status === "scheduled" || status === "en_route";
  return (Boolean(p.complete) && status === "in_progress") || (Boolean(p.stopClock) && onIt);
}

// ---------------------------------------------------------------------------------------------
// What the geofence knows, kept on the phone
// ---------------------------------------------------------------------------------------------

const PREFIX = "crewtavo-geofence:";
export const geofenceKey = (companyId: string, userId: string, day: string) => `${PREFIX}${companyId}:${userId}:${day}`;

export function loadGeofence(key: string): GeofenceState {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as GeofenceState | null;
    return saved && typeof saved === "object" && saved.sites && typeof saved.sites === "object" ? saved : emptyGeofence();
  } catch {
    return emptyGeofence(); // Storage turned off, or something unreadable: start again.
  }
}

export function saveGeofence(key: string, state: GeofenceState) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    // Other days' are done with.
    const mine = key.slice(0, key.lastIndexOf(":") + 1);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(mine) && k !== key) localStorage.removeItem(k);
    }
  } catch {
    // Kept in memory only for this look: at worst an arrival is noticed again after a reload.
  }
}

/** The visits the geofence watches: today's, that this person is on, at a property with a point on the map. */
export function geofenceSites(visits: readonly MyDayVisit[] | undefined): GeofenceSite[] {
  return (visits ?? [])
    .filter((v) => v.mine !== false && v.property?.lat != null && v.property?.lng != null && v.status !== "completed" && v.status !== "cancelled")
    .map((v) => ({ visitId: v.id, lat: v.property!.lat!, lng: v.property!.lng!, place: v.property!.line1 || v.title, status: v.status }));
}

/**
 * The visits a clock tap by this person touches, for core noteTap: the one it goes onto, the one
 * it leaves (their clock as this phone shows it), and one it leaves only if still on it.
 */
export function tappedVisits(change: ClockChange, userId: string, running: Pick<ShownClock, "visit"> | null | undefined): string[] {
  if (change.geofence || !change.who.includes(userId)) return [];
  return [...new Set([change.target?.visit?.id, running?.visit?.id, change.fromVisit].filter((id): id is string => Boolean(id)))];
}

// ---------------------------------------------------------------------------------------------
// On the phone
// ---------------------------------------------------------------------------------------------

/** "Clock started at 12 Oak St" and the like: what the phone did by itself, said as it happens. */
export function actionWords(action: GeofenceAction, place: string): string | null {
  if (action.kind === "start-clock") return `Clock started at ${place}`;
  if (action.kind === "stop-clock") return action.travel ? `You left ${place}, so your clock is on driving` : `Clock stopped as you left ${place}`;
  return null;
}

/** A buzz, and the phone's own notification for someone who allowed Crewtavo's. Neither is promised. */
function buzz(title: string, body: string, visitId: string) {
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // Not every phone can.
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !navigator.serviceWorker) return;
  void navigator.serviceWorker.ready
    .then((sw) => sw.showNotification(title, { body, tag: `geofence:${visitId}`, icon: "/icon-192.png", badge: "/icon-192.png", data: { link: `/field/visits/${visitId}` } }))
    .catch(() => undefined);
}

/** Their clock as the clock card shows it now, waiting taps included. */
const shownClock = (queryClient: QueryClient, companyId: string, userId: string) => queryClient.getQueryData<ShownClock | null>(["running-timer", companyId, userId]) ?? null;

/**
 * Runs the clock at the property while the screen that calls it is open. Returns whether it's on
 * for this person, and whether the phone refused to say where it is.
 */
export function useGeofence(): { mode: "off" | "remind" | "clock"; watching: boolean; denied: boolean } {
  const session = useSession();
  const queryClient = useQueryClient();
  const setting = geofenceSetting(session.company.settings);
  const on = setting.mode !== "off" && keepsTime(session);
  const day = useMyDay();
  // Loaded so their clock is on hand (shownClock) when a look needs it.
  useRunningTimer(session.company.id, session.userId, on);
  const sites = on ? geofenceSites(day.data?.today) : [];
  const key = geofenceKey(session.company.id, session.userId, todayIn(session.company.timezone));
  const [denied, setDenied] = useState(false);
  // Sent by the action registered for it (fieldActions.ts), as the clock card's taps are.
  const clock = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    // Said as it happened (actionWords), not again when it reaches the server.
    meta: { success: () => null },
    onMutate: (change: ClockChange) => showClockTap(queryClient, { key: "clock", change }),
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) void queryClient.invalidateQueries({ queryKey: [k] });
    },
  });

  // The latest of everything, for looks that happen between renders.
  const now = useRef({ session, setting, sites, all: [] as string[], visits: [] as MyDayVisit[], key, clock: clock.mutate });
  now.current = { session, setting, sites, all: (day.data?.today ?? []).map((v) => v.id), visits: day.data?.today ?? [], key, clock: clock.mutate };

  // A clock tap of their own, anywhere in the app, takes the visits it touches off the geofence while they're there.
  useEffect(() => {
    if (!on) return;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "pending" || event.mutation.options.mutationKey?.[0] !== "clock") return;
      const change = event.mutation.state.variables as ClockChange | undefined;
      const { session: s, key: k } = now.current;
      if (!change || change.companyId !== s.company.id) return;
      const ids = tappedVisits(change, s.userId, shownClock(queryClient, s.company.id, s.userId));
      if (ids.length) saveGeofence(k, noteTap(loadGeofence(k), ids));
    });
  }, [on, queryClient]);

  const watching = on && sites.length > 0 && typeof navigator !== "undefined" && Boolean(navigator.geolocation);
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let looking = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    let last: Fix | null = null;

    const act = (action: GeofenceAction, fix: Fix) => {
      const { session: s, visits, clock: send } = now.current;
      const visit = visits.find((v) => v.id === action.visitId);
      if (!visit) return null;
      const place = visit.property?.line1 || visit.title;
      if (action.kind === "start-clock" || action.kind === "stop-clock") {
        // Where the phone was, only where the company keeps that; six places is about 10 cm.
        const where: ClockPlace | undefined = recordsPlaces(s.company) ? { lat: Number(fix.lat.toFixed(6)), lng: Number(fix.lng.toFixed(6)), accuracy: Math.round(fix.accuracy) } : undefined;
        const target: ClockTarget | null =
          action.kind === "start-clock" ? { category: "visit", visit: { id: visit.id, jobId: visit.job?.id ?? null, title: visit.title } } : action.travel ? { category: "drive" } : null;
        const change: ClockChange = { ...clockChange(s, [s.userId], target, where, new Date(action.at).toISOString()), geofence: true, ...(action.kind === "stop-clock" && { fromVisit: visit.id }) };
        send(change);
        const words = actionWords(action, place)!;
        toast.success(words, onlineManager.isOnline() ? undefined : { description: "Saved on this phone. It sends when you have signal." });
        return words;
      }
      const prompt: GeofencePrompt =
        action.kind === "ask-start"
          ? { id: `start:${visit.id}`, kind: "start", visitId: visit.id, jobId: visit.job?.id ?? null, title: visit.title, place, clockOnly: action.clockOnly }
          : { id: `finish:${visit.id}`, kind: "finish", visitId: visit.id, jobId: visit.job?.id ?? null, title: visit.title, place, complete: action.complete, stopClock: action.stopClock };
      return prompt;
    };

    const handle = (fix: Fix) => {
      const { session: s, setting: g, sites: watched, all, key: k } = now.current;
      const before = keepSites(loadGeofence(k), all);
      const { state, events } = trackFix(before, fix, watched, g.radius);
      saveGeofence(k, state);
      const running = shownClock(queryClient, s.company.id, s.userId);
      const actions = geofenceActions(events, { mode: g.mode, sites: watched, clock: running && { category: running.category, visitId: running.visit?.id ?? null }, day: onDayClock(s) });
      // What the phone did, then what it asks, one question per visit with what it did above it.
      const done = new Map<string, string>();
      for (const action of actions) {
        const result = act(action, fix);
        if (typeof result === "string") done.set(action.visitId, result);
        else if (result) {
          const prompt = { ...result, done: done.get(result.visitId) };
          ask(prompt);
          const text = promptText(prompt);
          buzz(text.title, prompt.done ? `${prompt.done}. ${text.question}` : text.question, prompt.visitId);
        }
      }
      // Done with nothing to ask: still buzzed, so they know.
      for (const [visitId, words] of done) if (!actions.some((a) => a.visitId === visitId && a.kind.startsWith("ask"))) buzz(words, "", visitId);
    };

    const later = () => {
      clearTimeout(next);
      if (stopped) return;
      const { sites: watched, setting: g, key: k } = now.current;
      const plan = nextLook(loadGeofence(k), last, watched, g.radius);
      next = setTimeout(() => look(plan.precise), plan.delayMs);
    };
    const look = (precise: boolean) => {
      if (stopped || looking) return;
      looking = true;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          looking = false;
          if (stopped) return;
          setDenied(false);
          last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp || Date.now() };
          handle(last);
          later();
        },
        (e) => {
          looking = false;
          if (stopped) return;
          // Said on the card; asked again when the screen is opened again.
          if (e.code === e.PERMISSION_DENIED) return setDenied(true);
          later();
        },
        { enableHighAccuracy: precise, timeout: 20_000, maximumAge: 15_000 },
      );
    };
    // Back on the screen (the phone paused it in the background): look at once.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(next);
      look(true);
    };
    look(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(next);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [watching, key, queryClient]);

  return { mode: on ? setting.mode : "off", watching, denied };
}
