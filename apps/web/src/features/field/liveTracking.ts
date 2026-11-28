/**
 * Live sharing on the way: while one of my visits is en route and Crewtavo is open on this
 * phone, the phone sends where it is to the client's live map (the /track link in the on-my-way
 * text), every few seconds, until the visit starts or the worker taps Stop sharing.
 *
 * A phone browser can't report from the background — here, as in Lead Control: when the screen
 * locks or the app is put away, the pings pause, and the client's page says how old the last
 * one is instead of pretending the pin is live. A ping that can't be sent (no signal) is
 * dropped, never queued: by the time it could go, it's a place the crew has left, and the next
 * fix is the true one. Only the latest place is kept on the server (visit_live_location).
 *
 * The sharing is the team's, never a sub's, and it runs only for a worker who has acknowledged
 * the en_route_sharing notice (locationNotice.ts): until then the phone's position isn't read
 * for it at all. A company turns the whole thing off in Settings → Client notifications
 * (settings.tracking.live).
 */
import { useEffect } from "react";
import { api } from "@/lib/api";
import { isSub, useSession, type Session } from "@/lib/session";
import { locate } from "./fieldData";
import { acknowledgedAt, noticesFor } from "./locationNotice";

/** How often the phone reports while en route: smooth enough on a map, kind to the battery. */
export const PING_MS = 12_000;

type Who = Pick<Session, "userId" | "role" | "subcontractor"> & { company: Session["company"] };

/** Whether this phone may share its place with a client now: the notice applies and was acknowledged. */
export const canShare = (session: Who) => !isSub(session) && noticesFor(session).includes("en_route_sharing") && acknowledgedAt(session, "en_route_sharing") !== null;

/**
 * One report of where this phone is, for the visit's live map. False when there's no fix to
 * send (permission refused, no signal for a position) or the send didn't land: the caller just
 * waits for the next round.
 */
export async function postPing(companyId: string, visitId: string): Promise<boolean> {
  const place = await locate();
  if ("missing" in place) return false;
  try {
    await api.post(`/visits/${visitId}/ping`, { lat: place.lat, lng: place.lng, accuracy: place.accuracy }, { companyId });
    return true;
  } catch {
    return false;
  }
}

/** The worker's Stop sharing for this trip: the client's map stops there, and later pings are refused. */
export const stopSharing = (companyId: string, visitId: string) => api.post(`/visits/${visitId}/stop-sharing`, {}, { companyId });

/**
 * Keeps the client's map fed while `visitId` is en route: a report at once, then every PING_MS,
 * and another whenever the app comes back to the front (the interval slept while it was away).
 * Stops by itself when the visit leaves en route (the caller passes null) or the screen closes.
 */
export function useLiveSharing(visitId: string | null) {
  const session = useSession();
  const companyId = session.company.id;
  const allowed = canShare(session);
  useEffect(() => {
    if (!visitId || !allowed) return;
    let live = true;
    const send = () => {
      if (live) void postPing(companyId, visitId);
    };
    send();
    const timer = setInterval(send, PING_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") send();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [visitId, companyId, allowed]);
}
