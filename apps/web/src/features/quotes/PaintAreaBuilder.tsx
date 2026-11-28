/**
 * The one-screen area builder (painting companies only — QuotePage mounts it behind
 * isPaintingTrade): Josue's way of building a proposal, the RollerQuote shape. Pick an
 * area — interior or exterior, from the presets or a name of your own — say how big it is
 * once (length × width × height), then tap the surfaces in it on or off: walls, ceiling
 * and trim with a coats stepper, doors by kind and count, baseboards by size, prep as one
 * flat amount. The rates are the price book's, shown on the row; the breakdown and the
 * room total price themselves as you tap. No add-a-surface screens: saving an area writes
 * ordinary quote lines carrying the room in paint_detail (core's buildPaintArea), so the
 * line list below, the painting math panel, the packages and the client's page all read
 * them exactly as they read any other line. Lines in a room that the builder doesn't
 * manage (a custom item added by hand) are never touched.
 *
 * Areas are built before packages are offered: once a proposal carries options, its
 * lines belong to the options, and this card says so instead of editing a copy.
 */
import {
  buildPaintArea,
  emptyPaintAreaDraft,
  isPaintPrepLine,
  paintAreaDraftFromLines,
  paintAreaManagedServiceIds,
  paintAreaPresets,
  paintAreaQuantities,
  paintAreaServiceFor,
  paintDetailFrom,
  paintSurfacesFor,
  PAINT_AREA_PRESET_SURFACES,
  PAINT_DOOR_TYPES,
  type PaintAreaDraft,
  type PaintAreaScope,
  type PaintAreaService,
  type PaintProduct,
  type PaintSettings,
} from "@crewtavo/core/painting";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { nextSort } from "./LineItems";
import styles from "./PaintAreaBuilder.module.css";

export interface AreaLine {
  id: string;
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  option_id: string | null;
  sort: number;
  paint_detail?: unknown;
}

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  scope: "interior" | "exterior" | "trim";
  cost_per_gallon: number;
  markup_pct: number;
  coverage_per_gallon: number;
  active: boolean;
}

interface ServiceRow extends PaintAreaService {
  formula: string | null;
}

/** One area on the screen: the room it was read from (null while it's new), and its draft. */
export interface AreaSession {
  key: number;
  originalRoom: string | null;
  draft: PaintAreaDraft;
}

let sessionKey = 0;
const newSession = (originalRoom: string | null, draft: PaintAreaDraft): AreaSession => ({ key: ++sessionKey, originalRoom, draft });

/** The sessions a quote's lines open with: one per room the builder manages, in line order. */
export function sessionsFromLines(lines: readonly AreaLine[], services: readonly PaintAreaService[]): AreaSession[] {
  const rooms: string[] = [];
  for (const line of lines) {
    if (line.option_id !== null) continue;
    const room = paintDetailFrom(line.paint_detail).room;
    if (room && !rooms.includes(room)) rooms.push(room);
  }
  const sessions: AreaSession[] = [];
  for (const room of rooms) {
    const roomLines = lines.filter((l) => l.option_id === null && paintDetailFrom(l.paint_detail).room === room);
    const draft = paintAreaDraftFromLines(room, roomLines, services);
    if (draft) sessions.push(newSession(room, draft));
  }
  return sessions;
}

/** What changes when the lines do: the rooms and the managed lines in them, by id. */
export function linesSignature(lines: readonly AreaLine[], services: readonly PaintAreaService[]): string {
  const managed = new Set([...paintAreaManagedServiceIds("interior", services), ...paintAreaManagedServiceIds("exterior", services)]);
  return lines
    .filter((l) => l.option_id === null && ((l.service_id && managed.has(l.service_id)) || isPaintPrepLine(l)))
    .map((l) => `${l.id}:${paintDetailFrom(l.paint_detail).room ?? ""}`)
    .join("|");
}

export function PaintAreaBuilder({ quoteId, lines, editable, hasOptions, onChanged }: {
  quoteId: string;
  lines: readonly AreaLine[];
  editable: boolean;
  hasOptions: boolean;
  onChanged: () => void;
}) {
  const { company } = useSession();
  const settingsQ = useQuery({ queryKey: ["painting", company.id, "settings"], queryFn: () => api.get<{ settings: PaintSettings }>("/painting/settings") });
  const productsQ = useQuery({ queryKey: ["painting", company.id, "products"], queryFn: () => api.get<{ products: ProductRow[] }>("/painting/products") });
  const servicesQ = useQuery({
    queryKey: ["painting", company.id, "area-services"],
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, category, unit, unit_price, unit_cost, taxable, formula").eq("company_id", company.id).eq("active", true)) as unknown as ServiceRow[],
  });

  const services = useMemo(() => servicesQ.data ?? [], [servicesQ.data]);
  const settings = settingsQ.data?.settings;
  const products = useMemo(
    () => (productsQ.data?.products ?? []).filter((p) => p.active).map((p): PaintProduct & { key: string } => ({
      key: p.id,
      name: p.name,
      brand: p.brand,
      scope: p.scope,
      costPerGallon: Number(p.cost_per_gallon),
      markupPct: Number(p.markup_pct),
      coveragePerGallon: Number(p.coverage_per_gallon),
    })),
    [productsQ.data],
  );

  const [sessions, setSessions] = useState<AreaSession[]>([]);
  const signature = useMemo(() => linesSignature(lines, services), [lines, services]);
  const [seenSignature, setSeenSignature] = useState<string | null>(null);
  // The lines are the record: when they change under the screen (a save here, an edit in
  // the list below), the areas are read from them again. A draft being typed in doesn't
  // change the lines, so typing never resets it.
  useEffect(() => {
    if (!servicesQ.data || signature === seenSignature) return;
    setSeenSignature(signature);
    setSessions(sessionsFromLines(lines, services));
  }, [servicesQ.data, signature, seenSignature, lines, services]);

  const save = useMutation({
    mutationFn: async (session: AreaSession) => {
      const built = buildPaintArea(session.draft, services, settings!, products);
      const managed = new Set([...paintAreaManagedServiceIds("interior", services), ...paintAreaManagedServiceIds("exterior", services)]);
      const formulaOf = new Map(services.map((s) => [s.id, s.formula]));
      if (session.originalRoom) {
        const stale = lines.filter(
          (l) => l.option_id === null && paintDetailFrom(l.paint_detail).room === session.originalRoom && ((l.service_id && managed.has(l.service_id)) || isPaintPrepLine(l)),
        );
        for (const line of stale) unwrap(await supabase().from("quote_line_items").delete().eq("id", line.id));
      }
      if (built.lines.length) {
        // Sorted after every line there is, the line list's own rule for new lines.
        const base = nextSort(lines);
        const insertRows = built.lines.map((line, i) => ({
          company_id: company.id,
          quote_id: quoteId,
          service_id: line.service_id,
          name: line.name,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unit_price: line.unit_price,
          unit_cost: line.unit_cost,
          taxable: line.taxable,
          formula: line.service_id ? formulaOf.get(line.service_id) ?? null : null,
          paint_detail: line.paint_detail,
          sort: base + i,
        }));
        unwrap(await supabase().from("quote_line_items").insert(insertRows as never));
      }
      return session.key;
    },
    onSuccess: () => { toast.success("Area saved", { tone: "quote" }); onChanged(); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: async (session: AreaSession) => {
      if (!session.originalRoom) return;
      const managed = new Set([...paintAreaManagedServiceIds("interior", services), ...paintAreaManagedServiceIds("exterior", services)]);
      const stale = lines.filter(
        (l) => l.option_id === null && paintDetailFrom(l.paint_detail).room === session.originalRoom && ((l.service_id && managed.has(l.service_id)) || isPaintPrepLine(l)),
      );
      for (const line of stale) unwrap(await supabase().from("quote_line_items").delete().eq("id", line.id));
    },
    onSuccess: () => { toast.success("Area removed", { tone: "quote" }); onChanged(); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!settings || servicesQ.isPending) return null;

  const title = <>Build by area <span className={styles.titleNote}>pick an area, size it once, tap its surfaces</span></>;

  if (hasOptions) {
    return (
      <Section title={title}>
        <p className="muted small" style={{ margin: 0 }}>This proposal is offered as packages, so its lines belong to the options the client picks from. Areas are built here first, then offered as packages from the painting math panel.</p>
      </Section>
    );
  }

  const patch = (key: number, draft: PaintAreaDraft) =>
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, draft } : s)));

  return (
    <Section title={title}>
      <div className={styles.stack}>
        {sessions.map((session) => (
          <AreaCard
            key={session.key}
            session={session}
            services={services}
            settings={settings}
            products={products}
            editable={editable}
            saving={save.isPending && save.variables?.key === session.key}
            onDraft={(draft) => patch(session.key, draft)}
            onSave={() => save.mutate(session)}
            onRemove={() => (session.originalRoom ? remove.mutate(session) : setSessions((prev) => prev.filter((s) => s.key !== session.key)))}
          />
        ))}
        {editable && (
          <div>
            <Button
              icon="plus"
              onClick={() => setSessions((prev) => [...prev, newSession(null, emptyPaintAreaDraft("interior"))])}
            >
              Add an area
            </Button>
          </div>
        )}
        {sessions.length === 0 && !editable && <p className="muted small" style={{ margin: 0 }}>No areas yet.</p>}
      </div>
    </Section>
  );
}

function AreaCard({ session, services, settings, products, editable, saving, onDraft, onSave, onRemove }: {
  session: AreaSession;
  services: readonly ServiceRow[];
  settings: PaintSettings;
  products: readonly (PaintProduct & { key: string })[];
  editable: boolean;
  saving: boolean;
  onDraft: (draft: PaintAreaDraft) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const draft = session.draft;
  const built = useMemo(() => buildPaintArea(draft, services, settings, products), [draft, services, settings, products]);
  const quantities = draft.feet ? paintAreaQuantities(draft.feet) : null;
  const measuredOn = paintSurfacesFor(draft.scope).some((def) => def.measure !== "count" && draft.surfaces[def.key]?.on);

  const setScope = (scope: PaintAreaScope) => {
    if (scope === draft.scope) return;
    // The room and its size carry over; its surfaces are the new scope's, at their defaults.
    onDraft({ ...emptyPaintAreaDraft(scope, draft.room), prep: draft.prep, feet: draft.feet });
  };
  const pickPreset = (name: string) => {
    const only = PAINT_AREA_PRESET_SURFACES[name];
    if (!only) return onDraft({ ...draft, room: name });
    const surfaces = { ...draft.surfaces };
    for (const def of paintSurfacesFor(draft.scope)) {
      if (surfaces[def.key]) surfaces[def.key] = { ...surfaces[def.key]!, on: only.includes(def.key) };
    }
    onDraft({ ...draft, room: name, surfaces });
  };
  // The feet as typed: the draft only carries a size once all three are in, but the
  // inputs keep the partial numbers so typing one at a time doesn't lose them.
  const [feetText, setFeetText] = useState(() => ({
    l: draft.feet ? String(draft.feet.l) : "",
    w: draft.feet ? String(draft.feet.w) : "",
    h: draft.feet ? String(draft.feet.h) : "",
  }));
  const setFeet = (part: "l" | "w" | "h", raw: string) => {
    const text = { ...feetText, [part]: raw };
    setFeetText(text);
    const l = Number(text.l);
    const w = Number(text.w);
    const h = Number(text.h);
    onDraft({ ...draft, feet: l > 0 && w > 0 && h > 0 ? { l, w, h } : null });
  };
  const setSurface = (key: string, patchPart: Partial<PaintAreaDraft["surfaces"][string]>) =>
    onDraft({ ...draft, surfaces: { ...draft.surfaces, [key]: { ...draft.surfaces[key]!, ...patchPart } } });

  const stepper = (value: number, set: (n: number) => void, label: string, min = 1) => (
    <span className={styles.stepper} role="group" aria-label={label}>
      <button type="button" disabled={!editable || value <= min} onClick={() => set(value - 1)} aria-label={`One less, ${label}`}>−</button>
      <span className={styles.stepValue}>{value}</span>
      <button type="button" disabled={!editable} onClick={() => set(value + 1)} aria-label={`One more, ${label}`}>+</button>
    </span>
  );

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className="segmented" role="group" aria-label="Inside or outside">
          {(["interior", "exterior"] as const).map((scope) => (
            <button key={scope} type="button" aria-pressed={draft.scope === scope} disabled={!editable} onClick={() => setScope(scope)}>
              {scope === "interior" ? "Interior" : "Exterior"}
            </button>
          ))}
        </span>
        {editable && (
          <button type="button" className={styles.remove} onClick={onRemove}>
            {session.originalRoom ? "Remove area" : "Discard"}
          </button>
        )}
      </div>

      <div className={styles.chips} role="group" aria-label="Areas">
        {paintAreaPresets(draft.scope).map((name) => (
          <button
            key={name}
            type="button"
            className={styles.chip}
            aria-pressed={draft.room === name}
            disabled={!editable}
            onClick={() => pickPreset(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <input
        className="input"
        aria-label="Area name"
        placeholder={draft.scope === "interior" ? "Area name — Master bedroom, or your own" : "Area name — Whole house, or your own"}
        value={draft.room}
        disabled={!editable}
        onChange={(e) => onDraft({ ...draft, room: e.target.value })}
      />

      <div className={styles.feet}>
        {(["l", "w", "h"] as const).map((part) => (
          <label key={part} className={styles.feetField}>
            <span>{part === "l" ? "Length" : part === "w" ? "Width" : "Height"} (ft)</span>
            <input
              className="input"
              inputMode="decimal"
              aria-label={`${part === "l" ? "Length" : part === "w" ? "Width" : "Height"} in feet`}
              value={feetText[part]}
              disabled={!editable}
              onChange={(e) => setFeet(part, e.target.value)}
            />
          </label>
        ))}
        {quantities && (
          <span className={styles.feetNote}>Walls {Math.round(quantities.walls)} sq ft · Ceiling {Math.round(quantities.ceiling)} sq ft</span>
        )}
      </div>

      <div className={styles.surfaces}>
        {paintSurfacesFor(draft.scope).map((def) => {
          const state = draft.surfaces[def.key]!;
          const service = paintAreaServiceFor(def, state.variant, services);
          const row = built.breakdown.find((r) => r.key === def.key);
          return (
            <div key={def.key} className={styles.surface}>
              <label className={styles.surfaceMain}>
                <input type="checkbox" checked={state.on} disabled={!editable} onChange={(e) => setSurface(def.key, { on: e.target.checked })} />
                <span className={styles.surfaceLabel}>{def.label}</span>
                <span className={styles.rate}>
                  {service ? `${formatMoney(Number(service.unit_price))} / ${service.unit}` : "not in your price book"}
                </span>
              </label>
              {state.on && def.key === "baseboards" && (
                <span className="segmented" role="group" aria-label="Baseboard size">
                  {Object.keys(def.services).map((variant) => (
                    <button key={variant} type="button" aria-pressed={state.variant === variant} disabled={!editable} onClick={() => setSurface(def.key, { variant })}>
                      {variant} in
                    </button>
                  ))}
                </span>
              )}
              {state.on && def.key === "doors" && (
                <select
                  className="input"
                  style={{ width: 170 }}
                  aria-label="Door kind"
                  value={draft.doorType}
                  disabled={!editable}
                  onChange={(e) => onDraft({ ...draft, doorType: e.target.value })}
                >
                  {PAINT_DOOR_TYPES.map((d) => <option key={d.key} value={d.key}>{d.label}{d.slabs > 1 ? ` (×${d.slabs})` : ""}</option>)}
                </select>
              )}
              {state.on && def.coats && stepper(state.coats, (n) => setSurface(def.key, { coats: n }), `${def.label} coats`)}
              {state.on && !def.coats && stepper(state.count, (n) => setSurface(def.key, { count: n }), `${def.label} count`, 0)}
              {state.on && row && !row.missing && row.quantity > 0 && (
                <span className={styles.rowTotal}>{formatMoney(row.total)}</span>
              )}
            </div>
          );
        })}
        <div className={styles.surface}>
          <label className={styles.surfaceMain}>
            <input type="checkbox" checked={draft.prep.on} disabled={!editable} onChange={(e) => onDraft({ ...draft, prep: { ...draft.prep, on: e.target.checked } })} />
            <span className={styles.surfaceLabel}>Prep</span>
            <span className={styles.rate}>one flat amount</span>
          </label>
          {draft.prep.on && (
            <span className={styles.prepAmount}>
              $<input
                className="input"
                style={{ width: 90 }}
                inputMode="decimal"
                aria-label="Prep amount"
                value={draft.prep.amount > 0 ? String(draft.prep.amount) : ""}
                disabled={!editable}
                onChange={(e) => onDraft({ ...draft, prep: { ...draft.prep, amount: Number(e.target.value) || 0 } })}
              />
            </span>
          )}
          {draft.prep.on && draft.prep.amount > 0 && <span className={styles.rowTotal}>{formatMoney(draft.prep.amount)}</span>}
        </div>
      </div>

      {measuredOn && !draft.feet && (
        <p className={styles.hint}>Add the area's size to price its walls, ceiling and trim — the pieces (doors, shutters) price without it.</p>
      )}
      {built.breakdown.some((r) => r.missing) && (
        <p className={styles.hint}>A surface that's on isn't in your price book, so it isn't priced — add it in the price book and it prices here.</p>
      )}

      <div className={styles.breakdown}>
        {built.breakdown.filter((r) => r.quantity > 0 || r.key === "prep").map((r) => (
          <div key={r.key} className={styles.breakRow}>
            <span>{r.label}{r.coats ? ` · ${r.coats} coat${r.coats === 1 ? "" : "s"}` : ""} — {r.quantity} {r.unit} × {formatMoney(r.rate)}{r.gallons > 0 ? ` · ${r.gallons} gal` : ""}</span>
            <span>{formatMoney(r.total)}</span>
          </div>
        ))}
        <div className={`${styles.breakRow} ${styles.roomTotal}`}>
          <span>Room total</span>
          <span>{formatMoney(built.roomTotal)}</span>
        </div>
      </div>

      {editable && (
        <div className={styles.actions}>
          <Button variant="primary" loading={saving} disabled={!draft.room.trim()} onClick={onSave}>
            {session.originalRoom ? "Save area" : "Add area to the proposal"}
          </Button>
          {!draft.room.trim() && <span className={styles.hint}>Name the area first — a preset chip or your own name.</span>}
        </div>
      )}
    </div>
  );
}
