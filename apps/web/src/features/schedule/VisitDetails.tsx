/**
 * A visit at a glance, the way Google Calendar opens an event: when, where (tap for directions in
 * your maps app), who it's for, the crew and people, equipment, gate code and instructions — and,
 * below the facts, what the visit itself produced: its photos, checklists, measurements and voice
 * walkthrough, each only when there is some. Edit opens the visit form; nothing changes from here
 * by accident. A sheet on phones.
 */
import { marketingOn } from "@crewtavo/core/marketing";
import { roomAreas } from "@crewtavo/core/roomMeasurements";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { MetaLine } from "@/components/ui/InboxList";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { EntityStatus, visitKindText } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatNumber, formatTime } from "@/lib/format";
import { visitPlace } from "@/lib/maps";
import { photoLinks } from "@/lib/photoMarkup";
import { can, hasRole, useSession } from "@/lib/session";
import { useVisitExtraScope } from "../field/FieldExtras";
import { usePendingChanges } from "./changeRequests";
import { lengthLabel } from "./VisitDialog";
import { intlLocale, msg, t } from "@/lib/i18n";

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

export function VisitDetails({ visitId, onClose, onEdit }: { visitId: string; onClose: () => void; onEdit?: () => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const tz = session.company.timezone;
  const office = hasRole(session, "admin", "office", "estimator");
  const showcases = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(session.company.settings);
  const visit = useQuery({
    queryKey: ["visit-details", visitId],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("visits")
          .select(
            "id, title, kind, status, scheduled_on, starts_at, ends_at, route_order, time_fixed, notes, address, hold_reason, series_day, series_total, crew:crews(name, color), assignees:visit_assignees(user_id), equipment:visit_equipment(equipment:equipment(name)), job:jobs(id, number, title, instructions, client:clients(id, display_name, phone, email)), request:requests(id, title, details, client:clients(id, display_name, phone, email)), property:properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes)",
          )
          .eq("id", visitId)
          .maybeSingle(),
        msg("This visit"),
      ),
  });
  const v = visit.data;
  // A client's request to move or cancel it: Edit answers it.
  const asked = usePendingChanges(Boolean(onEdit)).data?.some((r) => r.visit_id === visitId);
  const people = useQuery({
    queryKey: ["visit-details", visitId, "people", v?.assignees.map((a) => a.user_id).join(",")],
    enabled: Boolean(v?.assignees.length),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", v!.assignees.map((a) => a.user_id))),
  });
  const access = useQuery({
    queryKey: ["visit-details", visitId, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });

  // What the visit itself produced — its photos, checklists, measurements and voice walkthrough.
  // Quiet extras: any of them failing (or not existing yet) leaves the facts above untouched.
  const photos = useQuery({
    queryKey: ["visit-details", visitId, "photos"],
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().from("attachments").select("id, path, marked_path, file_name").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"));
      return photoLinks(rows);
    },
  });
  const checklists = useQuery({
    queryKey: ["visit-details", visitId, "checklists"],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("checklist_responses").select("id, completed_at, template:checklist_templates(name)").eq("visit_id", visitId).order("created_at")),
  });
  const measurements = useQuery({
    queryKey: ["visit-details", visitId, "measurements"],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("visit_measurements").select("id, label, length_ft, width_ft, height_ft").eq("visit_id", visitId).order("created_at")),
  });
  const voice = useQuery({
    queryKey: ["visit-details", visitId, "voice"],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("visit_voice_reports").select("id, status, items, created_at").eq("visit_id", visitId).order("created_at", { ascending: false }).limit(1))[0] ?? null,
  });

  const extras = useVisitExtraScope(visitId, Boolean(v?.job));
  const client = v?.job?.client ?? v?.request?.client ?? null;
  const place = v ? visitPlace(v) : null;
  const minutes = v?.starts_at && v.ends_at ? Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60_000) : null;
  const when = v
    ? `${v.scheduled_on ? day(v.scheduled_on) : t("Not scheduled yet")}${v.starts_at ? ` · ${formatTime(v.starts_at, tz)}${v.ends_at ? ` – ${formatTime(v.ends_at, tz)}` : ""}` : v.scheduled_on ? ` · ${t("Anytime")}` : ""}`
    : "";
  const codes = access.data;
  const names = (people.data ?? []).map((p) => p.full_name).filter(Boolean);

  const photoRows = photos.data ?? [];
  const checklistRows = checklists.data ?? [];
  // One quiet line for the measuring: how many rooms, and the wall area where a height was taken
  // (walls need one — roomAreas says null without it); ceilings alone are just "surfaces".
  const measureRows = measurements.data ?? [];
  const areas = measureRows.map((m) => roomAreas({ length_ft: Number(m.length_ft), width_ft: Number(m.width_ft), height_ft: m.height_ft == null ? null : Number(m.height_ft) }));
  const wallsTotal = areas.reduce((sum, a) => sum + (a.walls ?? 0), 0);
  const ceilingTotal = areas.reduce((sum, a) => sum + a.ceiling, 0);
  const measureLine = measureRows.length
    ? areas.some((a) => a.walls != null)
      ? t("Measurements: {rooms} · {area} sq ft of walls", { rooms: t.plural(measureRows.length, { one: "{count} room", other: "{count} rooms" }), area: formatNumber(Math.round(wallsTotal)) })
      : t("Measurements: {rooms} · {area} sq ft of surfaces", { rooms: t.plural(measureRows.length, { one: "{count} room", other: "{count} rooms" }), area: formatNumber(Math.round(ceilingTotal)) })
    : null;
  // The latest voice walkthrough, said plainly: its items when it's ready, what's missing when it isn't.
  const report = voice.data;
  const reportItems = report && Array.isArray(report.items) ? report.items.length : 0;
  const voiceLine = !report
    ? null
    : report.status === "ready"
      ? t("Voice walkthrough — {items}", { items: t.plural(reportItems, { one: "{count} item", other: "{count} items" }) })
      : report.status === "needs_key"
        ? t("Voice walkthrough — needs the OpenAI key (Apps → ChatGPT)")
        : report.status === "transcribed"
          ? t("Voice walkthrough — transcribed")
          : report.status === "recorded"
            ? t("Voice walkthrough — recorded")
            : t("Voice walkthrough — failed");

  return (
    <Dialog open onClose={onClose} title={v?.title ?? t("Visit")} description={v?.job ? <>{t("Job #{number}", { number: v.job.number })}{client ? ` · ${client.display_name}` : ""}</> : client?.display_name} className="visit-sheet">
      <div className="dialog-body">
        {visit.error && <ErrorState error={visit.error} onRetry={() => visit.refetch()} />}
        {visit.isPending && (
          <div className="visit-facts" aria-hidden="true">
            {[60, 80, 45].flatMap((w) => [<Skeleton key={`i${w}`} width={16} height={16} radius={8} />, <Skeleton key={`t${w}`} width={`${w}%`} />])}
          </div>
        )}
        {v && (
          <>
            {/* Its status as a dot and words, then what else is true of it, quietly; a client's request in amber, since someone has to answer it. */}
            <MetaLine
              className="visit-status"
              parts={[
                <EntityStatus key="status" kind="visit" status={v.status} />,
                v.kind !== "job" && visitKindText(v.kind),
                v.route_order && v.status === "scheduled" && <span key="stop"><Icon name="navigation" size={13} />{t("Stop {number}", { number: v.route_order })}</span>,
                v.time_fixed && v.starts_at && <span key="fixed"><Icon name="lock" size={13} />{t("Fixed time")}</span>,
                v.series_total && v.series_total > 1 && t("Day {day} of {days}", { day: v.series_day, days: v.series_total }),
                asked && <span key="asked" className="visit-flag"><Icon name="refresh" size={13} />{t("Change requested")}</span>,
              ]}
            />

            <div className="visit-facts">
              <Icon name="clock" size={16} />
              <div>
                {when}
                {minutes != null && <span className="muted"> ({lengthLabel(minutes)})</span>}
              </div>

              {v.property && (
                <>
                  <Icon name="pin" size={16} />
                  <div>
                    {v.property.label && <strong className="visit-label">{v.property.label}</strong>}
                    <MapsLink className="address-link" place={v.property}>{addressLine(v.property)}</MapsLink>
                    {(codes?.gate_code || codes?.lockbox_code) && (
                      <span className="visit-codes">
                        {codes.gate_code && <span><Icon name="lock" size={12} />{t("Gate")} <strong>{codes.gate_code}</strong></span>}
                        {codes.lockbox_code && <span><Icon name="lock" size={12} />{t("Lockbox")} <strong>{codes.lockbox_code}</strong></span>}
                      </span>
                    )}
                    {codes?.instructions && <span className="visit-sub pre-wrap">{codes.instructions}</span>}
                    {v.property.notes && <span className="visit-sub pre-wrap">{v.property.notes}</span>}
                  </div>
                </>
              )}
              {!v.property && place && (
                <>
                  <Icon name="pin" size={16} />
                  <div><MapsLink className="address-link" place={place}>{v.address}</MapsLink></div>
                </>
              )}

              {client && (
                <>
                  <Icon name="user" size={16} />
                  <div>
                    {office ? <Link to={`/clients/${client.id}`}>{client.display_name}</Link> : client.display_name}
                    {client.phone && <> · <a href={`tel:${client.phone}`}>{client.phone}</a></>}
                    {office && client.email && <span className="visit-sub">{client.email}</span>}
                  </div>
                </>
              )}

              {(v.crew || names.length > 0) && (
                <>
                  <Icon name="users" size={16} />
                  <div>
                    {v.crew && <span className="visit-crew"><i style={{ background: v.crew.color ?? "var(--text-4)" }} aria-hidden="true" />{v.crew.name}</span>}
                    {names.length > 0 && <span className="visit-sub">{names.join(", ")}</span>}
                  </div>
                </>
              )}

              {v.equipment.length > 0 && (
                <>
                  <Icon name="truck" size={16} />
                  <div>{v.equipment.map((e) => e.equipment?.name).filter(Boolean).join(", ")}</div>
                </>
              )}

              {v.hold_reason && (
                <>
                  <Icon name="cloud" size={16} />
                  <div className="visit-warn">{t("Weather: {reason}", { reason: v.hold_reason })}</div>
                </>
              )}

              {(v.notes || v.job?.instructions || v.request?.details) && (
                <>
                  <Icon name="note" size={16} />
                  <div className="stack-sm">
                    {v.notes && <span className="pre-wrap">{v.notes}</span>}
                    {v.job?.instructions && <Note className="muted" text={v.job.instructions} />}
                    {!v.job && v.request?.details && <span className="pre-wrap muted">{v.request.details}</span>}
                  </div>
                </>
              )}

              {/* Extra work on this visit of a repeating job, without prices (the job page has those). */}
              {extras.data && extras.data.length > 0 && (
                <>
                  <Icon name="plus" size={16} />
                  <div className="stack-sm">
                    <strong>{t("Extra work on this visit")}</strong>
                    {extras.data.map((e) => <span key={e.id}>{e.name}{Number(e.quantity) !== 1 || e.unit !== "ea" ? ` · ${Number(e.quantity)} ${e.unit}` : ""}</span>)}
                  </div>
                </>
              )}
            </div>

            {/* What the visit produced, in the same facts style, each piece only when there is some:
                the photos taken on it, the checklists filled in, the rooms measured, the voice
                walkthrough. The working visit itself (camera, checklist, voice) is Open visit below. */}
            {(photoRows.length > 0 || checklistRows.length > 0 || measureLine || voiceLine) && (
              <div className="visit-facts">
                {photoRows.length > 0 && (
                  <>
                    <Icon name="image" size={16} />
                    <div>
                      <div className="visit-photo-strip">
                        {photoRows.slice(0, 8).map((p) =>
                          p.url ? (
                            <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                              <img src={p.url} alt={p.file_name} loading="lazy" />
                            </a>
                          ) : null,
                        )}
                        {photoRows.length > 8 && <span className="visit-photo-more">{t("+{count} more", { count: photoRows.length - 8 })}</span>}
                      </div>
                      <span className="visit-sub">{t.plural(photoRows.length, { one: "{count} photo", other: "{count} photos" })}</span>
                    </div>
                  </>
                )}

                {checklistRows.length > 0 && (
                  <>
                    <Icon name="checklist" size={16} />
                    <div className="stack-sm">
                      {checklistRows.map((r) => (
                        <span key={r.id}>{r.template?.name ?? t("Checklist")} — {r.completed_at ? t("Done") : t("In progress")}</span>
                      ))}
                    </div>
                  </>
                )}

                {measureLine && (
                  <>
                    <Icon name="ruler" size={16} />
                    <div>{measureLine}</div>
                  </>
                )}

                {voiceLine && (
                  <>
                    <Icon name="chat" size={16} />
                    <div>{voiceLine}</div>
                  </>
                )}
              </div>
            )}

            {/* Ways to reach it on the left as quiet buttons (tiles on a phone), Edit the one green button. */}
            <div className="visit-actions">
              {place && <MapsLink className="btn" place={place}><Icon name="navigation" size={16} />{t("Directions")}</MapsLink>}
              {client?.phone && <a className="btn" href={`tel:${client.phone}`}><Icon name="phone" size={16} />{t("Call")}</a>}
              {client?.phone && <a className="btn" href={`sms:${client.phone}`}><Icon name="messages" size={16} />{t("Text")}</a>}
              {office && v.job && <Link className="btn" to={`/jobs/${v.job.id}`} onClick={onClose}><Icon name="job" size={16} />{t("Open job")}</Link>}
              {/* The full working visit — camera, checklists, measurements, voice — for the office too, not just the field. */}
              <Link className="btn" to={`/field/visits/${v.id}`} onClick={onClose}><Icon name="clipboard" size={16} />{t("Open visit")}</Link>
              {/* A finished visit's before and after photos, on a page to share (Marketing → Showcases). */}
              {showcases && v.job && v.status === "completed" && (
                <Menu
                  label={t("More actions")}
                  title={v.title}
                  triggerClassName="btn btn-icon visit-more"
                  // A tile with its word on a phone, like the ways to reach it beside it; just the dots on a computer.
                  trigger={<><Icon name="more" size={18} /><span className="visit-more-text" aria-hidden="true">{t("More")}</span></>}
                  items={[{ label: t("Make a showcase"), icon: "image", onSelect: () => { onClose(); navigate(`/marketing?tab=showcases&job=${v.job!.id}&visit=${v.id}`); } }]}
                />
              )}
              {onEdit && <Button variant="primary" icon="edit" onClick={onEdit}>{t("Edit")}</Button>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
