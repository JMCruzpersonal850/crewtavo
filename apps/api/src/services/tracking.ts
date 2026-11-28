/**
 * Live tracking on the way: the client's map of the crew between the On my way tap and the visit
 * starting. Four pieces, all Crewtavo's own (the 2026-11-25 study): a signed link of kind "track"
 * (lib/links.ts), minted by the on-my-way automation as {{tracking_link}}; the crew phone posting
 * its place every few seconds while the field app is open (the poster in the web app); one row
 * per visit holding only the latest place (visit_live_location — never a trail); and the public
 * page's data (trackView below, served by routes/public.ts GET /track/:token).
 *
 * A phone browser can't report from the background, here as in Lead Control: when the crew's
 * screen locks or the app is put away, the pings pause and the page says how old the last one is
 * instead of pretending the pin is live. Tracking exists only while the visit is en route: the
 * moment it starts, is completed or is cancelled, the page stops showing a place.
 */
import { driveBetween, liveTrackingOn, scheduleSettings } from "@crewtavo/core";
import { brandColor } from "@crewtavo/core/social";
import type { Env } from "../env";
import { firstName } from "../lib/email";
import { dbError, HttpError } from "../lib/http";
import { clientLink } from "../lib/links";
import type { Db } from "../lib/supabase";
import { logoImage } from "./logo";

/** The signed live-tracking link for a visit, for the on-my-way text ({{tracking_link}}). */
export const trackingLink = (env: Env, baseUrl: string, companyId: string, visitId: string) =>
  clientLink(env, baseUrl, { c: companyId, t: "track", id: visitId });

interface VisitRow {
  id: string;
  status: string;
  crew_id: string | null;
  eta_at: string | null;
}

/** The visit a ping or a page is about, in this company; 404 in the caller's words when it isn't. */
async function visitOf(admin: Db, companyId: string, visitId: string): Promise<VisitRow> {
  const { data, error } = await admin.from("visits").select("id, status, crew_id, eta_at").eq("company_id", companyId).eq("id", visitId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, "Visit not found.");
  return data;
}

/**
 * Whether this person is on the visit: named on it (visit_assignees) or in its crew
 * (crew_members). The tap that starts the sharing is theirs, and any of them may keep it going —
 * the last phone to report is the one the client follows. Subcontractors are not on either list
 * in this sense (their visits come by offer), and v1 doesn't share a sub's place.
 */
export async function onVisit(admin: Db, companyId: string, visit: Pick<VisitRow, "id" | "crew_id">, userId: string): Promise<boolean> {
  const { data: named, error } = await admin.from("visit_assignees").select("user_id").eq("company_id", companyId).eq("visit_id", visit.id).eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  if (named) return true;
  if (!visit.crew_id) return false;
  const { data: inCrew, error: crewError } = await admin.from("crew_members").select("user_id").eq("company_id", companyId).eq("crew_id", visit.crew_id).eq("user_id", userId).maybeSingle();
  if (crewError) throw dbError(crewError);
  return Boolean(inCrew);
}

/** The company's settings as the server reads them (for the tracking switch and the route speed). */
async function companySettings(admin: Db, companyId: string): Promise<unknown> {
  const { data, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw dbError(error);
  return data?.settings ?? null;
}

export interface Ping {
  lat: number;
  lng: number;
  accuracy?: number;
}

/**
 * A crew phone's place while its visit is on the way: kept as the visit's one live row, replacing
 * the last. Only from someone on the visit, only while it's en route, only while the company
 * shares live tracking, and never after the worker tapped Stop sharing for this trip (a visit
 * sent out again starts clean: services/schedule.ts clears the row as it goes en route again).
 */
export async function recordPing(admin: Db, companyId: string, visitId: string, userId: string, ping: Ping, now = new Date()): Promise<{ ok: true }> {
  if (!(await liveOn(admin, companyId))) throw new HttpError(403, "This company doesn't share live tracking.");
  const visit = await visitOf(admin, companyId, visitId);
  if (visit.status !== "en_route") throw new HttpError(409, "The visit isn't on its way.");
  if (!(await onVisit(admin, companyId, visit, userId))) throw new HttpError(403, "You're not on this visit.");
  const { data: row, error } = await admin.from("visit_live_location").select("sharing_stopped_at").eq("visit_id", visitId).maybeSingle();
  if (error) throw dbError(error);
  // A stop stands until the trip ends. A visit sent out again starts clean without any help
  // from here: services/schedule.ts deletes the row as it goes en route again.
  if (row?.sharing_stopped_at) throw new HttpError(409, "Location sharing was stopped for this visit.");
  const { error: writeError } = await admin
    .from("visit_live_location")
    .upsert(
      { visit_id: visitId, company_id: companyId, user_id: userId, lat: ping.lat, lng: ping.lng, accuracy: ping.accuracy ?? null, recorded_at: now.toISOString(), sharing_stopped_at: null },
      { onConflict: "visit_id" },
    );
  if (writeError) throw dbError(writeError);
  return { ok: true };
}

/**
 * The worker's Stop sharing: from then on the visit's page shows no place, and later pings for
 * this trip are refused (recordPing). The row is kept (with the stop on it) so the refusal
 * stands; the next time the visit goes en route it starts clean.
 */
export async function stopSharing(admin: Db, companyId: string, visitId: string, userId: string, now = new Date()): Promise<{ ok: true }> {
  const visit = await visitOf(admin, companyId, visitId);
  if (!(await onVisit(admin, companyId, visit, userId))) throw new HttpError(403, "You're not on this visit.");
  const { error } = await admin
    .from("visit_live_location")
    .upsert({ visit_id: visitId, company_id: companyId, user_id: userId, sharing_stopped_at: now.toISOString() }, { onConflict: "visit_id" });
  if (error) throw dbError(error);
  return { ok: true };
}

/** Whether the company shares live tracking at all (settings.tracking.live, on unless turned off). */
export async function liveOn(admin: Db, companyId: string): Promise<boolean> {
  return liveTrackingOn(await companySettings(admin, companyId));
}

export type TrackState = "en_route" | "waiting" | "arrived" | "stopped" | "ended";

/**
 * The public tracking page's data, shaped here so the page only draws it: where the crew last
 * reported (and how long ago — the page's honesty label), how long the drive from there should
 * take by the house estimator (the same driveBetween the office routes trust), and the visit's
 * own state. Nothing internal: no costs, no notes, no one's number but the company's.
 *
 *   en_route  the crew is on the way and a phone has reported: show the map.
 *   waiting   on the way, no place yet (the app is closed, or permission was refused).
 *   arrived   the visit has started or finished: the crew is there; no place is shown.
 *   stopped   the worker stopped sharing for this trip: no place is shown.
 *   ended     the visit was cancelled or put back on the schedule.
 */
export async function trackView(admin: Db, companyId: string, visitId: string, now = new Date()) {
  const [{ data: company, error: companyError }, { data: visit, error: visitError }, { data: live, error: liveError }] = await Promise.all([
    admin.from("companies").select("id, name, phone, settings").eq("id", companyId).maybeSingle(),
    admin
      .from("visits")
      .select("title, status, eta_at, property:properties(line1, line2, city, region, postal_code, lat, lng)")
      .eq("company_id", companyId)
      .eq("id", visitId)
      .maybeSingle(),
    admin.from("visit_live_location").select("user_id, lat, lng, recorded_at, sharing_stopped_at").eq("company_id", companyId).eq("visit_id", visitId).maybeSingle(),
  ]);
  if (companyError) throw dbError(companyError);
  if (visitError) throw dbError(visitError);
  if (liveError) throw dbError(liveError);
  if (!company || !visit) throw new HttpError(404, "This link has expired or isn't valid. Ask for a new one.");

  const property = (visit.property ?? null) as { line1: string | null; line2: string | null; city: string | null; region: string | null; postal_code: string | null; lat: number | null; lng: number | null } | null;
  const destination = property?.lat != null && property?.lng != null ? { lat: property.lat, lng: property.lng } : null;

  // A stop stands until the trip ends: a visit sent out again starts clean because
  // services/schedule.ts deletes the row as it goes en route again.
  const stoppedAt = live?.sharing_stopped_at ?? null;

  const state: TrackState =
    visit.status === "en_route"
      ? stoppedAt
        ? "stopped"
        : live?.lat != null && live?.lng != null && live?.recorded_at
          ? "en_route"
          : "waiting"
      : visit.status === "in_progress" || visit.status === "completed"
        ? "arrived"
        : "ended";

  // The crew member whose phone reported last, by first name only, and only while they're coming.
  let crew: { first_name: string } | null = null;
  if (state === "en_route" && live?.user_id) {
    const { data: profile } = await admin.from("profiles").select("full_name").eq("user_id", live.user_id).maybeSingle();
    const name = firstName(profile?.full_name);
    if (name) crew = { first_name: name };
  }

  const ping =
    state === "en_route" && live?.lat != null && live?.lng != null && live?.recorded_at
      ? { lat: live.lat, lng: live.lng, at: live.recorded_at, age_seconds: Math.max(0, Math.round((now.getTime() - Date.parse(live.recorded_at)) / 1000)) }
      : null;

  // About how long from where they last reported, by the house estimator; before the first
  // report, the arrival the on-my-way text already promised (visits.eta_at), when there is one.
  let eta_minutes: number | null = null;
  if (ping && destination) {
    eta_minutes = Math.max(1, Math.round(driveBetween(ping, destination, scheduleSettings(company.settings).speedMph).minutes));
  } else if (state === "waiting" && visit.eta_at) {
    const minutes = Math.round((Date.parse(visit.eta_at) - now.getTime()) / 60_000);
    if (minutes > 0) eta_minutes = minutes;
  }

  return {
    state,
    company: { name: company.name, phone: company.phone ?? null, logo: logoImage("", company.id, company.settings)?.src ?? null, color: brandColor(company.settings) },
    visit: {
      title: visit.title,
      address: property ? [property.line1, [property.city, property.region].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "",
      destination,
    },
    crew,
    ping,
    eta_minutes,
  };
}

export type TrackView = Awaited<ReturnType<typeof trackView>>;
