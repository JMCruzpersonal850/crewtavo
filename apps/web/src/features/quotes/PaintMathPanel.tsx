/**
 * A painting proposal's working numbers, beside the lines (office only, painting companies
 * only — QuotePage mounts it behind isPaintingTrade): each surface's labor at the sub rate,
 * the paint it takes with gallons rounded up per room (a line in no room rounds on its own), material
 * with its markup, then overhead and the warranty reserve, and the price the margin sets —
 * profit in dollars and percent before anything is sent. The math itself is core's
 * paintProposalMath; this panel only feeds it the proposal's lines and shows its work.
 * "Price the lines from this" writes the math onto the lines (ordinary line items, so the
 * shared totals never change shape), and packages offer the same scope Good / Better / Best
 * through the Hub's pick-and-sign options.
 */
import { paintAreaDetailFrom, paintDetailFrom, paintProposalMath, type PaintProduct, type PaintSettings, type PaintSurfaceInput } from "@crewtavo/core/painting";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import styles from "./QuotePage.module.css";

interface PanelLine {
  id: string;
  service_id: string | null;
  name: string;
  quantity: number;
  unit: string;
  /** The line's room (paint_detail), so its gallons round up with its room's. */
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

interface PackageRow {
  id: string;
  set_name: string;
  name: string;
  tier: string;
  scope: string;
  is_enabled: boolean;
  is_default: boolean;
  sort: number;
}

const toProduct = (row: ProductRow): PaintProduct & { key: string } => ({
  key: row.id,
  name: row.name,
  brand: row.brand,
  scope: row.scope,
  costPerGallon: Number(row.cost_per_gallon),
  markupPct: Number(row.markup_pct),
  coveragePerGallon: Number(row.coverage_per_gallon),
});

export function PaintMathPanel({ quoteId, lines, editable, hasOptions, onChanged }: {
  quoteId: string;
  lines: readonly PanelLine[];
  editable: boolean;
  hasOptions: boolean;
  onChanged: () => void;
}) {
  const { company } = useSession();
  const settingsQ = useQuery({ queryKey: ["painting", company.id, "settings"], queryFn: () => api.get<{ settings: PaintSettings }>("/painting/settings") });
  const productsQ = useQuery({ queryKey: ["painting", company.id, "products"], queryFn: () => api.get<{ products: ProductRow[] }>("/painting/products") });
  const packagesQ = useQuery({ queryKey: ["painting", company.id, "packages"], queryFn: () => api.get<{ packages: PackageRow[] }>("/painting/packages") });
  const servicesQ = useQuery({
    queryKey: ["painting", company.id, "service-categories"],
    queryFn: async () => unwrap(await supabase().from("services").select("id, category, unit_cost").eq("company_id", company.id)) as Array<{ id: string; category: string | null; unit_cost: number | null }>,
  });

  const [margin, setMargin] = useState<string | null>(null);
  const [coats, setCoats] = useState(2);
  const [pickInterior, setPickInterior] = useState<string>("");
  const [pickExterior, setPickExterior] = useState<string>("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const seededPicks = useRef(false);

  const settings = settingsQ.data?.settings;
  const products = productsQ.data?.products ?? [];
  const packages = (packagesQ.data?.packages ?? []).filter((p) => p.is_enabled);
  const marginPct = margin === null ? (settings?.defaultMarginPct ?? 30) : Number(margin) || 0;

  // Once the packages land, pre-pick each scope's default set (the tiers its default sits in).
  useEffect(() => {
    if (seededPicks.current || !packagesQ.data) return;
    seededPicks.current = true;
    const all = packagesQ.data.packages.filter((p) => p.is_enabled);
    const picked = new Set<string>();
    for (const scope of ["interior", "exterior"] as const) {
      const inScope = all.filter((p) => p.scope === scope);
      const home = inScope.find((p) => p.is_default) ?? inScope[0];
      if (home) for (const p of inScope.filter((x) => x.set_name === home.set_name)) picked.add(p.id);
    }
    setChosen(new Set([...picked].slice(0, 3)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packagesQ.data]);

  const apply = useMutation({
    mutationFn: async (rows: Array<{ id: string; unit_price: number; unit_cost: number; material_cost: number }>) => {
      for (const row of rows) {
        unwrap(await supabase().from("quote_line_items").update({ unit_price: row.unit_price, unit_cost: row.unit_cost, material_cost: row.material_cost }).eq("id", row.id));
      }
    },
    onSuccess: () => { toast.success("Lines priced from the painting math", { tone: "quote" }); onChanged(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const offer = useMutation({
    mutationFn: () => api.post(`/painting/${quoteId}/packages`, { package_ids: [...chosen] }),
    onSuccess: () => { toast.success("Packages offered on this proposal", { tone: "quote" }); onChanged(); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!settings || servicesQ.isPending) return null;
  const categoryOf = new Map((servicesQ.data ?? []).map((s) => [s.id, s.category]));
  const active = products.filter((p) => p.active);
  const productFor = (scope: "interior" | "exterior", unit: string): (PaintProduct & { key: string }) | null => {
    if (unit === "ft") {
      const trim = active.find((p) => p.scope === "trim");
      if (trim) return toProduct(trim);
    }
    const row = active.find((p) => p.id === (scope === "interior" ? pickInterior : pickExterior)) ?? active.find((p) => p.scope === scope) ?? null;
    return row ? toProduct(row) : null;
  };
  const paintLines = lines
    .map((line) => {
      const category = line.service_id ? categoryOf.get(line.service_id) : null;
      const scope = category === "Interior" ? "interior" : category === "Exterior" ? "exterior" : null;
      return scope ? { line, scope: scope as "interior" | "exterior" } : null;
    })
    .filter((x): x is { line: PanelLine; scope: "interior" | "exterior" } => x !== null);
  const serviceOf = new Map((servicesQ.data ?? []).map((s) => [s.id, s]));
  // How a line is worked: area and trim lines price at the scope's sub rate with their paint;
  // hour lines are the crew's hours; per-piece lines (a door, a garage door) carry the price
  // book's per-piece cost as their fee and drink no gallons of their own.
  const inputs: PaintSurfaceInput[] = paintLines.map(({ line, scope }) => {
    // Gallons round up per room: lines in the same room share its name as the key; a line in
    // no room keeps its own, so it rounds on its own as it did before rooms.
    // A line the one-screen builder wrote carries its own coats (in its paint_detail); it
    // wins over the panel's pick, so the panel's gallons are the builder's gallons.
    const base = { scope, quantity: Number(line.quantity), coats: paintAreaDetailFrom(line.paint_detail).coats ?? coats, room: paintDetailFrom(line.paint_detail).room ?? line.id };
    if (line.unit === "hr") return { ...base, laborHoursPerUnit: 1, product: null };
    if (line.unit === "ea" || line.unit === "visit" || line.unit === "job") {
      const cost = line.service_id ? serviceOf.get(line.service_id)?.unit_cost : null;
      return { ...base, flatFeePerUnit: cost != null ? Number(cost) : null, product: null };
    }
    return { ...base, product: productFor(scope, line.unit) };
  });
  const math = paintProposalMath(inputs, { ...settings, defaultMarginPct: Math.min(Math.max(marginPct, 0), 99) });
  const profit = math.price - math.totalCost;

  const productPicker = (scope: "interior" | "exterior", label: string) => {
    const choices = active.filter((p) => p.scope === scope);
    if (choices.length < 2) return null;
    const value = (scope === "interior" ? pickInterior : pickExterior) || choices[0]!.id;
    const set = scope === "interior" ? setPickInterior : setPickExterior;
    return (
      <div className="line">
        <span>{label}</span>
        <select className="input" style={{ width: 190 }} value={value} disabled={!editable} onChange={(e) => set(e.target.value)} aria-label={label}>
          {choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    );
  };

  return (
    <Section title="Painting math">
      <div className={`totals ${styles.sum}`}>
        {paintLines.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>Add interior or exterior surfaces from the price list and the working numbers — labor, paint, overhead, margin — show here before you send it.</p>
        ) : (
          <>
            {paintLines.map(({ line }, i) => {
              const m = math.surfaces[i]!;
              return (
                <div className="line" key={line.id}>
                  <span>{line.name} · {Number(line.quantity)} {line.unit}<br />
                    <span className="muted small">{`labor ${formatMoney(m.laborCost)}`}{m.gallons > 0 ? ` · ${m.gallons} gal ${formatMoney(m.materialCost)}` : ""}</span>
                  </span>
                  <span>{formatMoney(m.priceTotal)}</span>
                </div>
              );
            })}
            {productPicker("interior", "Interior paint")}
            {productPicker("exterior", "Exterior paint")}
            <div className="line">
              <span>Coats</span>
              <span className="segmented" role="group" aria-label="Coats">
                {[1, 2, 3].map((n) => <button key={n} type="button" aria-pressed={coats === n} disabled={!editable} onClick={() => setCoats(n)}>{n}</button>)}
              </span>
            </div>
            <div className="line"><span>Direct cost</span><span>{formatMoney(math.directCost)}</span></div>
            <div className="line"><span>Overhead ({settings.overheadPct}%)</span><span>{formatMoney(math.overheadCost)}</span></div>
            <div className="line"><span>Warranty reserve ({settings.warrantyReservePct}%)</span><span>{formatMoney(math.warrantyReserveCost)}</span></div>
            <div className="line"><span>Total cost</span><span>{formatMoney(math.totalCost)}</span></div>
            <div className="line">
              <span>Margin</span>
              <span>
                <input className="input" style={{ width: 64, display: "inline-block" }} inputMode="decimal" aria-label="Margin percent" value={margin ?? String(settings.defaultMarginPct)} disabled={!editable} onChange={(e) => setMargin(e.target.value)} /> %
              </span>
            </div>
            <div className="line grand"><span>Price at that margin</span><span>{formatMoney(math.price)}</span></div>
            <div className="line">
              <span>Profit</span>
              <span data-tone={profit < 0 ? "danger" : "good"}>{formatMoney(profit)}{math.price > 0 ? ` (${Math.round((profit / math.price) * 100)}%)` : ""}</span>
            </div>
            {editable && (
              <Button
                variant="primary"
                loading={apply.isPending}
                onClick={() => apply.mutate(paintLines.map(({ line }, i) => {
                  const m = math.surfaces[i]!;
                  const qty = Math.max(Number(line.quantity), 1);
                  return { id: line.id, unit_price: m.unitPrice, unit_cost: Math.round((m.directCost / qty) * 100) / 100, material_cost: m.materialCost };
                }))}
              >
                Price the lines from this
              </Button>
            )}
          </>
        )}
        {editable && !hasOptions && packages.length > 0 && paintLines.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <p className="muted small" style={{ margin: "0 0 6px" }}>Offer it as packages — the client picks and signs one in the Hub:</p>
            {packages.map((p) => (
              <label key={p.id} className="line" style={{ cursor: "pointer" }}>
                <span>
                  <input
                    type="checkbox"
                    checked={chosen.has(p.id)}
                    onChange={(e) => setChosen((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) { if (next.size >= 3) { toast.error("A proposal offers up to 3 options"); return prev; } next.add(p.id); } else next.delete(p.id);
                      return next;
                    })}
                  />{" "}{p.name} <span className="muted small">({p.scope}{p.set_name ? ` · ${p.set_name}` : ""})</span>
                </span>
              </label>
            ))}
            <Button loading={offer.isPending} disabled={chosen.size === 0} onClick={() => offer.mutate()}>Offer the picked packages</Button>
          </div>
        )}
        {editable && !hasOptions && packages.length === 0 && (
          <p className="muted small" style={{ margin: "10px 0 0" }}>Your Good / Better / Best packages live in Settings → Painting — add them there to offer them here.</p>
        )}
      </div>
    </Section>
  );
}
