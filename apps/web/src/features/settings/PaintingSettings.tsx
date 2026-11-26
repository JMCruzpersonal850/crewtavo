/**
 * Settings → Painting: a painting business's numbers, paints and packages. Only a painting
 * business ever sees this tab (sections.ts gates it on the trade preset, and the API refuses
 * every other trade). The numbers are the ones its proposals price with: what a subcontractor
 * is paid per unit inside and out, the labor rate, the material markup, and the margin the
 * client price is set from after overhead and the warranty reserve. Products carry a cost per
 * gallon, their markup and what a gallon covers; packages are its Good / Better / Best, the
 * Lead Control templates, offered on a proposal for the client to pick and sign.
 */
import type { PaintSettings as PaintNumbers } from "@crewtavo/core/painting";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { NumberInput } from "@/components/ui/NumberInput";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { SettingsActions, SwitchRow } from "./SettingsKit";

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  scope: "interior" | "exterior" | "trim";
  cost_per_gallon: number;
  markup_pct: number;
  coverage_per_gallon: number;
  active: boolean;
  sort: number;
}

interface PackageRow {
  id: string;
  set_name: string;
  name: string;
  tier: "good" | "better" | "best";
  scope: "interior" | "exterior";
  tagline: string;
  description: string;
  paint_grade: string | null;
  product_id: string | null;
  product_name: string | null;
  coats: number;
  primer_coats: number;
  markup_pct: number;
  warranty_months: number;
  warranty: string;
  highlights: string[];
  is_enabled: boolean;
  is_default: boolean;
  sort: number;
}

const SCOPE_LABEL: Record<string, string> = { interior: "Interior", exterior: "Exterior", trim: "Trim" };
const TIER_LABEL: Record<string, string> = { good: "Good", better: "Better", best: "Best" };

export function PaintingSettings() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const base = ["painting", company.id] as const;
  const settings = useQuery({ queryKey: [...base, "settings"], queryFn: () => api.get<{ settings: PaintNumbers }>("/painting/settings") });
  const products = useQuery({ queryKey: [...base, "products"], queryFn: () => api.get<{ products: ProductRow[] }>("/painting/products") });
  const packages = useQuery({ queryKey: [...base, "packages"], queryFn: () => api.get<{ packages: PackageRow[] }>("/painting/packages") });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [...base] });
  };
  const setup = useMutation({
    mutationFn: () => api.post<{ products_created: number; packages_created: number }>("/painting/setup"),
    onSuccess: (r) => {
      toast.success(r.products_created || r.packages_created ? "Painting defaults added" : "Your painting defaults are already here", { tone: "quote" });
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (settings.isPending || products.isPending || packages.isPending) return <Loading label="Loading your painting setup"><SectionSkeleton rows={5} /></Loading>;
  if (settings.error || products.error || packages.error) return <ErrorState error={settings.error ?? products.error ?? packages.error} onRetry={() => { void settings.refetch(); void products.refetch(); void packages.refetch(); }} />;
  const empty = products.data.products.length === 0 && packages.data.packages.length === 0;

  return (
    <>
      {empty && (
        <Section title="Start with your defaults">
          <p className="settings-note">Your paints and your Good / Better / Best packages from Lead Control aren't here yet. Add them, then make them yours.</p>
          <Button variant="primary" loading={setup.isPending} onClick={() => setup.mutate()}>Add my paints and packages</Button>
        </Section>
      )}
      <NumbersSection key={JSON.stringify(settings.data.settings)} initial={settings.data.settings} onSaved={invalidate} />
      <ProductsSection products={products.data.products} onChanged={invalidate} />
      <PackagesSection packages={packages.data.packages} products={products.data.products} onChanged={invalidate} />
    </>
  );
}

/* The numbers every proposal prices with. */
function NumbersSection({ initial, onSaved }: { initial: PaintNumbers; onSaved: () => void }) {
  const [values, setValues] = useState<Record<keyof PaintNumbers, string>>({
    subInteriorRate: String(initial.subInteriorRate),
    subExteriorRate: String(initial.subExteriorRate),
    laborRate: String(initial.laborRate),
    materialMarkupPct: String(initial.materialMarkupPct),
    defaultMarginPct: String(initial.defaultMarginPct),
    overheadPct: String(initial.overheadPct),
    warrantyReservePct: String(initial.warrantyReservePct),
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: PaintNumbers) => api.put<{ settings: PaintNumbers }>("/painting/settings", { settings: next }),
    onSuccess: () => { toast.success("Painting numbers saved"); onSaved(); },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) as unknown as PaintNumbers;
    if (Object.values(next).some((v) => !Number.isFinite(v) || v < 0)) return setError("Every number has to be 0 or more.");
    if (next.defaultMarginPct >= 100) return setError("The margin has to be under 100%.");
    setError(null);
    save.mutate(next);
  };
  const field = (key: keyof PaintNumbers, label: string, hint: string, step = "any") => (
    <Field label={label} hint={hint}>
      <NumberInput className="input" min={0} step={step} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
    </Field>
  );
  return (
    <Section title="Your numbers">
      <form onSubmit={submit}>
        <div className="form-grid">
          {field("subInteriorRate", "Subcontractor rate — interior", "What a sub is paid per sq ft / lin ft inside.")}
          {field("subExteriorRate", "Subcontractor rate — exterior", "What a sub is paid per unit outside.")}
          {field("laborRate", "Labor rate", "Your own crew's rate, per hour.")}
          {field("materialMarkupPct", "Material markup", "On a product's cost, in percent. Each paint can carry its own.")}
          {field("defaultMarginPct", "Default margin", "The gross margin a proposal's price is set from. You can move it per proposal.")}
          {field("overheadPct", "Overhead", "Allocated on direct cost before the margin, in percent.")}
          {field("warrantyReservePct", "Warranty reserve", "Held back on direct cost for warranty work, in percent.")}
        </div>
        <FormError error={error} />
        <SettingsActions><Button type="submit" variant="primary" loading={save.isPending}>Save numbers</Button></SettingsActions>
      </form>
    </Section>
  );
}

/* The paints: cost per gallon, markup, coverage. */
function ProductsSection({ products, onChanged }: { products: ProductRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/painting/products/${id}`),
    onSuccess: onChanged,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section title="Products & materials" action={<Button icon="plus" onClick={() => setEditing("new")}>Add a paint</Button>}>
      {products.length === 0 ? (
        <EmptyState title="No paints yet">Add the paints you price with — what a gallon costs, and what it covers.</EmptyState>
      ) : (
        <ul className="settings-list">
          {products.map((p) => (
            <li key={p.id} className="settings-list-row">
              <div>
                <strong>{p.name}</strong>{p.brand ? ` · ${p.brand}` : ""} <span className="settings-note">{SCOPE_LABEL[p.scope]}{p.active ? "" : " · off"}</span>
                <div className="settings-note">{formatMoney(p.cost_per_gallon)} a gallon · {p.markup_pct}% markup · covers {p.coverage_per_gallon} per gallon</div>
              </div>
              <span className="row-actions">
                <Button size="sm" onClick={() => setEditing(p)}>Edit</Button>
                <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: `Delete ${p.name}?`, body: "Packages that point at it keep its name; the price link goes.", confirmLabel: "Delete paint", danger: true })) remove.mutate(p.id); }}>Delete</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing && <ProductDialog product={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </Section>
  );
}

function ProductDialog({ product, onClose, onSaved }: { product: ProductRow | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: product?.name ?? "",
    brand: product?.brand ?? "",
    scope: product?.scope ?? "interior",
    cost: String(product?.cost_per_gallon ?? ""),
    markup: String(product?.markup_pct ?? 30),
    coverage: String(product?.coverage_per_gallon ?? 400),
    active: product?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), brand: form.brand.trim() || null, scope: form.scope, cost_per_gallon: Number(form.cost), markup_pct: Number(form.markup), coverage_per_gallon: Number(form.coverage), active: form.active };
      return product ? api.put(`/painting/products/${product.id}`, body) : api.post("/painting/products", body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError("Give the paint a name.");
    if (!(Number(form.cost) >= 0) || !(Number(form.coverage) > 0)) return setError("Cost is 0 or more, and coverage has to be above 0.");
    save.mutate();
  };
  return (
    <Dialog open onClose={onClose} title={product ? `Edit ${product.name}` : "Add a paint"}>
      <form onSubmit={submit}>
        <Field label="Name" hint="As it reads on the proposal, e.g. Interior Acrylic Latex.">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Brand" optional>
          <input className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} placeholder="Sherwin-Williams" />
        </Field>
        <Field label="Used on">
          <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as ProductRow["scope"] })}>
            <option value="interior">Interior surfaces</option>
            <option value="exterior">Exterior surfaces</option>
            <option value="trim">Trim</option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Cost per gallon"><NumberInput className="input" min={0} step="any" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="Markup %"><NumberInput className="input" min={0} step="any" value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} /></Field>
          <Field label="Coverage per gallon" hint="Sq ft for walls, lin ft for trim."><NumberInput className="input" min={0} step="any" value={form.coverage} onChange={(e) => setForm({ ...form, coverage: e.target.value })} /></Field>
        </div>
        <SwitchRow label="In use" hint="Off paints stay on old proposals but aren't offered on new ones." checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
        <FormError error={error} />
        <SettingsActions>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save paint</Button>
        </SettingsActions>
      </form>
    </Dialog>
  );
}

/* The packages: Good / Better / Best, per set and scope. */
function PackagesSection({ packages, products, onChanged }: { packages: PackageRow[]; products: ProductRow[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<PackageRow | "new" | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/painting/packages/${id}`),
    onSuccess: onChanged,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sets = new Map<string, PackageRow[]>();
  for (const p of packages) sets.set(`${p.scope} · ${p.set_name || "Packages"}`, [...(sets.get(`${p.scope} · ${p.set_name || "Packages"}`) ?? []), p]);
  return (
    <Section title="Packages — Good / Better / Best" action={<Button icon="plus" onClick={() => setEditing("new")}>Add a package</Button>}>
      {packages.length === 0 ? (
        <EmptyState title="No packages yet">Your Good / Better / Best — the tiers a client picks between on a proposal.</EmptyState>
      ) : (
        [...sets.entries()].map(([set, rows]) => (
          <div key={set}>
            <h3 className="settings-subhead">{set}</h3>
            <ul className="settings-list">
              {rows.map((p) => (
                <li key={p.id} className="settings-list-row">
                  <div>
                    <strong>{TIER_LABEL[p.tier]} — {p.name}</strong> <span className="settings-note">{p.is_enabled ? (p.is_default ? " · the default" : "") : " · off"}</span>
                    <div className="settings-note">{[p.product_name, `${p.coats} coat${p.coats === 1 ? "" : "s"}`, p.markup_pct ? `+${p.markup_pct}%` : null, p.warranty].filter(Boolean).join(" · ")}</div>
                  </div>
                  <span className="row-actions">
                    <Button size="sm" onClick={() => setEditing(p)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: `Delete the ${p.name} package?`, body: "Proposals that offered it keep their copy.", confirmLabel: "Delete package", danger: true })) remove.mutate(p.id); }}>Delete</Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {editing && <PackageDialog pkg={editing === "new" ? null : editing} products={products} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
    </Section>
  );
}

function PackageDialog({ pkg, products, onClose, onSaved }: { pkg: PackageRow | null; products: ProductRow[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    set_name: pkg?.set_name ?? "",
    name: pkg?.name ?? "",
    tier: pkg?.tier ?? "better",
    scope: pkg?.scope ?? "interior",
    tagline: pkg?.tagline ?? "",
    description: pkg?.description ?? "",
    paint_grade: pkg?.paint_grade ?? "",
    product_id: pkg?.product_id ?? "",
    product_name: pkg?.product_name ?? "",
    coats: String(pkg?.coats ?? 2),
    primer_coats: String(pkg?.primer_coats ?? 0),
    markup_pct: String(pkg?.markup_pct ?? 0),
    warranty_months: String(pkg?.warranty_months ?? 36),
    warranty: pkg?.warranty ?? "",
    highlights: (pkg?.highlights ?? []).join("\n"),
    is_enabled: pkg?.is_enabled ?? true,
    is_default: pkg?.is_default ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        set_name: form.set_name.trim(), name: form.name.trim(), tier: form.tier, scope: form.scope,
        tagline: form.tagline.trim(), description: form.description.trim(),
        paint_grade: form.paint_grade.trim() || null, product_id: form.product_id || null, product_name: form.product_name.trim() || null,
        coats: Number(form.coats), primer_coats: Number(form.primer_coats), markup_pct: Number(form.markup_pct),
        warranty_months: Number(form.warranty_months), warranty: form.warranty.trim(),
        highlights: form.highlights.split("\n").map((h) => h.trim()).filter(Boolean),
        is_enabled: form.is_enabled, is_default: form.is_default,
      };
      return pkg ? api.put(`/painting/packages/${pkg.id}`, body) : api.post("/painting/packages", body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError("Give the package a name.");
    save.mutate();
  };
  return (
    <Dialog open onClose={onClose} title={pkg ? `Edit ${pkg.name}` : "Add a package"}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Set" hint="The template it belongs to."><input className="input" value={form.set_name} onChange={(e) => setForm({ ...form, set_name: e.target.value })} placeholder="Exterior Painting" /></Field>
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Better" /></Field>
          <Field label="Tier">
            <select className="input" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value as PackageRow["tier"] })}>
              <option value="good">Good</option><option value="better">Better</option><option value="best">Best</option>
            </select>
          </Field>
          <Field label="Scope">
            <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as PackageRow["scope"] })}>
              <option value="interior">Interior</option><option value="exterior">Exterior</option>
            </select>
          </Field>
        </div>
        <Field label="Tagline" optional><input className="input" value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} /></Field>
        <Field label="Description" optional><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label="Paint product (client words)"><input className="input" value={form.product_name} onChange={(e) => setForm({ ...form, product_name: e.target.value })} placeholder="Sherwin-Williams Duration" /></Field>
          <Field label="Priced with" hint="The paint its price is worked out with, when its cost is known.">
            <select className="input" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
              <option value="">No priced paint</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Paint grade" optional><input className="input" value={form.paint_grade} onChange={(e) => setForm({ ...form, paint_grade: e.target.value })} placeholder="Premium" /></Field>
          <Field label="Coats"><NumberInput className="input" min={1} max={5} step={1} value={form.coats} onChange={(e) => setForm({ ...form, coats: e.target.value })} /></Field>
          <Field label="Primer coats"><NumberInput className="input" min={0} max={3} step={1} value={form.primer_coats} onChange={(e) => setForm({ ...form, primer_coats: e.target.value })} /></Field>
          <Field label="Markup %" hint="The tier's uplift over the base price."><NumberInput className="input" min={0} step="any" value={form.markup_pct} onChange={(e) => setForm({ ...form, markup_pct: e.target.value })} /></Field>
          <Field label="Warranty (months)"><NumberInput className="input" min={0} step={1} value={form.warranty_months} onChange={(e) => setForm({ ...form, warranty_months: e.target.value })} /></Field>
          <Field label="Warranty, in a line"><input className="input" value={form.warranty} onChange={(e) => setForm({ ...form, warranty: e.target.value })} placeholder="3-year workmanship warranty" /></Field>
        </div>
        <Field label="What's included" hint="One per line — what the client reads on the option.">
          <textarea className="input" rows={6} value={form.highlights} onChange={(e) => setForm({ ...form, highlights: e.target.value })} />
        </Field>
        <SwitchRow label="Offered" hint="Off packages aren't offered on proposals." checked={form.is_enabled} onChange={(v) => setForm({ ...form, is_enabled: v })} />
        <SwitchRow label="The default" hint="The tier a proposal starts on, and the one pre-picked for the client." checked={form.is_default} onChange={(v) => setForm({ ...form, is_default: v })} />
        <FormError error={error} />
        <SettingsActions>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save package</Button>
        </SettingsActions>
      </form>
    </Dialog>
  );
}

