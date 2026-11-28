/**
 * The visit's measurements (visit_measurements): the rooms and areas the crew measured on site,
 * each with its length, width and ceiling height, the wall and ceiling areas those make
 * (@crewtavo/core/roomMeasurements), a note, and — when the measurement is about one of the
 * visit's photos — that photo. Saved straight to the table as they're added (the team reads and
 * writes it; subs never see this section), with the visit's totals at the bottom for the office
 * to price from.
 */
import { roomAreas } from "@crewtavo/core/roomMeasurements";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export interface MeasurementPhoto { id: string; url: string | null; file_name: string }

interface Measurement {
  id: string;
  label: string;
  length_ft: number;
  width_ft: number;
  height_ft: number | null;
  notes: string | null;
  photo_id: string | null;
  created_at: string;
}

/** A feet figure as the crew typed it: whole numbers plain, parts to two places. */
const feet = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** Square feet, rounded the way a price would be figured. */
const area = (n: number) => formatNumber(Math.round(n));

/** "12 × 10 ft · 8 ft ceilings" — the ceilings part only when a height was measured. */
const dims = (m: Measurement) => (m.height_ft != null ? t("{length} × {width} ft · {height} ft ceilings", { length: feet(m.length_ft), width: feet(m.width_ft), height: feet(m.height_ft) }) : t("{length} × {width} ft", { length: feet(m.length_ft), width: feet(m.width_ft) }));

export function VisitMeasurements({ visitId, photos, canEdit }: { visitId: string; photos: MeasurementPhoto[]; canEdit: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["visit-measurements", visitId];
  const list = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().from("visit_measurements").select("id, label, length_ft, width_ft, height_ft, notes, photo_id, created_at").eq("visit_id", visitId).order("created_at")) as Measurement[],
  });
  const rows = list.data ?? [];

  const [label, setLabel] = useState("");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [notes, setNotes] = useState("");
  const [photoId, setPhotoId] = useState("");
  const [formProblem, setFormProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (row: { label: string; length_ft: number; width_ft: number; height_ft: number | null; notes: string | null; photo_id: string | null }) =>
      unwrap(await supabase().from("visit_measurements").insert({ company_id: session.company.id, visit_id: visitId, created_by: session.userId, ...row })),
    onSuccess: () => {
      setLabel("");
      setLength("");
      setWidth("");
      setHeight("");
      setNotes("");
      setPhotoId("");
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => unwrap(await supabase().from("visit_measurements").delete().eq("id", id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const lengthFt = Number(length);
    const widthFt = Number(width);
    const heightFt = height.trim() ? Number(height) : null;
    if (!label.trim()) return setFormProblem(t("Give the room or area a name first."));
    if (!Number.isFinite(lengthFt) || lengthFt <= 0 || !Number.isFinite(widthFt) || widthFt <= 0) return setFormProblem(t("Length and width need to be numbers bigger than zero."));
    if (heightFt != null && (!Number.isFinite(heightFt) || heightFt <= 0)) return setFormProblem(t("Ceiling height needs to be a number bigger than zero, or left blank."));
    setFormProblem(null);
    save.mutate({ label: label.trim(), length_ft: lengthFt, width_ft: widthFt, height_ft: heightFt, notes: notes.trim() || null, photo_id: photoId || null });
  };

  const totals = rows.reduce(
    (sum, m) => {
      const a = roomAreas({ length_ft: m.length_ft, width_ft: m.width_ft, height_ft: m.height_ft });
      return { walls: sum.walls + (a.walls ?? 0), ceiling: sum.ceiling + a.ceiling };
    },
    { walls: 0, ceiling: 0 },
  );
  const photoFor = (m: Measurement) => (m.photo_id ? photos.find((p) => p.id === m.photo_id) ?? null : null);

  return (
    <Section title={t("Measurements")} count={rows.length || undefined} className="visit-measurements">
      {list.isPending ? (
        <Skeleton height={44} radius={8} />
      ) : list.error ? (
        <FormError error={list.error} />
      ) : (
        <>
          {rows.length > 0 && (
            <ul className="rel" role="list">
              {rows.map((m) => {
                const a = roomAreas({ length_ft: m.length_ft, width_ft: m.width_ft, height_ft: m.height_ft });
                const photo = photoFor(m);
                return (
                  <li key={m.id} className="rel-row">
                    {photo?.url && <span className="rel-lead"><img src={photo.url} alt={photo.file_name} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }} /></span>}
                    <div className="rel-body">
                      <span className="rel-head"><span className="rel-title">{m.label}</span><span className="rel-detail"> · {dims(m)}</span></span>
                      <span className="rel-sub">
                        {a.walls != null ? t("Walls {walls} sq ft · Ceiling {ceiling} sq ft", { walls: area(a.walls), ceiling: area(a.ceiling) }) : t("Ceiling {ceiling} sq ft · no ceiling height, so no wall area", { ceiling: area(a.ceiling) })}
                        {m.notes ? ` · ${m.notes}` : ""}
                      </span>
                    </div>
                    {canEdit && (
                      <span className="rel-actions">
                        <button type="button" className="icon-btn" aria-label={t("Remove measurement")} disabled={remove.isPending} onClick={() => remove.mutate(m.id)}><Icon name="trash" size={16} /></button>
                      </span>
                    )}
                  </li>
                );
              })}
              <li className="rel-row">
                <div className="rel-body">
                  <span className="rel-head"><span className="rel-title">{t("Totals")}</span></span>
                  <span className="rel-sub">{t("Walls {walls} sq ft · Ceilings {ceiling} sq ft", { walls: area(totals.walls), ceiling: area(totals.ceiling) })}</span>
                </div>
              </li>
            </ul>
          )}
          {canEdit && (
            <form onSubmit={submit} style={{ display: "grid", gap: 10, marginTop: rows.length ? 12 : 0 }}>
              <label className="field"><span>{t("Room or area")}</span>
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("Living room, exterior walls…")} maxLength={120} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <label className="field"><span>{t("Length (ft)")}</span>
                  <input className="input" inputMode="decimal" value={length} onChange={(e) => setLength(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="12" />
                </label>
                <label className="field"><span>{t("Width (ft)")}</span>
                  <input className="input" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="10" />
                </label>
                <label className="field"><span>{t("Ceiling height (ft)")}</span>
                  <input className="input" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="8" />
                </label>
              </div>
              {photos.length > 0 && (
                <label className="field"><span>{t("Photo")}</span>
                  <Select className="select" value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
                    <option value="">{t("No photo")}</option>
                    {photos.map((p) => <option key={p.id} value={p.id}>{p.file_name}</option>)}
                  </Select>
                </label>
              )}
              <label className="field"><span>{t("Notes")}</span>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("Anything the office should know…")} maxLength={500} />
              </label>
              {formProblem && <p className="field-hint" role="alert">{formProblem}</p>}
              <FormError error={save.error} />
              <div>
                <Button type="submit" icon="plus" loading={save.isPending}>{t("Add measurement")}</Button>
              </div>
            </form>
          )}
        </>
      )}
    </Section>
  );
}
