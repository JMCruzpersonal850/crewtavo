/**
 * Make a job a snow customer, or change one (Snow page): when the plow and the salt go out, how it's
 * served (how soon, how often in a long storm), who works it, what a storm bills, and whether the
 * client hears about it. Saved to snow_sites and snow_site_people; the crew is the job's own.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useCrews } from "../jobs/JobDialogs";
import { customer, nameOf, PRIORITIES, tiersOf, type Member, type Site } from "./snowData";

/** A whole number or a decimal typed into a field, or null for an empty one. */
const amount = (text: string) => (text.trim() === "" ? null : Number(text));
const within = (n: number | null, most: number) => n == null || (n > 0 && n <= most);

export function SnowSiteDialog({ site, team, onClose }: { site: Site | null; team: Member[]; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const crews = useCrews();
  const [jobId, setJobId] = useState(site?.job_id ?? "");
  const [term, setTerm] = useState("");
  const [trigger, setTrigger] = useState(String(site?.trigger_in ?? 2));
  const [salt, setSalt] = useState(site?.salt_trigger_in == null ? "" : String(site.salt_trigger_in));
  const [repeat, setRepeat] = useState(site?.repeat_in == null ? "" : String(site.repeat_in));
  const [clearBy, setClearBy] = useState(site?.clear_by?.slice(0, 5) ?? "");
  const [priority, setPriority] = useState(site?.priority ?? 2);
  const [crewId, setCrewId] = useState(site?.job.default_crew_id ?? "");
  const [tellClient, setTellClient] = useState(site?.tell_client ?? false);
  // A storm's price by depth, as typed: the last row, with no "up to", covers anything deeper.
  const [tiers, setTiers] = useState(() => (site ? tiersOf(site) : []).map((t) => ({ upTo: t.up_to_in == null ? "" : String(t.up_to_in), price: String(t.price) })));
  const before = site?.people.map((p) => p.user_id) ?? [];
  const [people, setPeople] = useState<string[]>(before);
  const jobs = useQuery({
    enabled: !site,
    queryKey: ["jobs", company.id, "snow-picker"],
    queryFn: async () => {
      const [all, taken] = await Promise.all([
        supabase().from("jobs").select("id, number, title, default_crew_id, client:clients(display_name)").eq("company_id", company.id).eq("status", "active").order("title").limit(500),
        supabase().from("snow_sites").select("job_id").eq("company_id", company.id).limit(1000),
      ]);
      const snow = new Set(unwrap(taken).map((s) => s.job_id));
      return unwrap(all).filter((j) => !snow.has(j.id));
    },
  });
  const shown = (jobs.data ?? []).filter((j) => `${j.title} ${j.client?.display_name ?? ""} ${j.number}`.toLowerCase().includes(term.toLowerCase()));
  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["snow", company.id] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    onClose();
  };
  const save = useMutation({
    meta: { inline: true, success: site ? "Snow customer saved" : "Snow customer added" },
    mutationFn: async () => {
      const plow = amount(trigger);
      const saltAt = amount(salt);
      const again = amount(repeat);
      if (!jobId) throw new Error("Pick the job for this customer.");
      if (plow == null || !within(plow, 48)) throw new Error("The plow trigger is more than 0 and at most 48 inches.");
      if (!within(saltAt, 48) || (saltAt != null && saltAt >= plow)) throw new Error("Salting starts at less snow than the plow trigger.");
      if (!within(again, 48)) throw new Error("Pushing again is every so many inches: more than 0, at most 48.");
      const priced = tiers.filter((t) => t.price.trim() !== "" || t.upTo.trim() !== "").map((t) => ({ up_to_in: amount(t.upTo), price: Number(t.price) }));
      if (priced.some((t) => !(t.price >= 0) || !within(t.up_to_in, 100))) throw new Error("Each storm price needs an amount, and a depth above 0 if it has one.");
      if (priced.filter((t) => t.up_to_in == null).length > 1) throw new Error("Only the last storm price can be left without a depth.");
      const row = { trigger_in: plow, salt_trigger_in: saltAt, repeat_in: again, clear_by: clearBy || null, priority, tell_client: tellClient, tiers: priced.sort((a, b) => (a.up_to_in ?? Infinity) - (b.up_to_in ?? Infinity)) };
      unwrap(site ? await supabase().from("snow_sites").update(row).eq("job_id", jobId) : await supabase().from("snow_sites").insert({ ...row, company_id: company.id, job_id: jobId }));
      unwrap(await supabase().from("jobs").update({ default_crew_id: crewId || null }).eq("id", jobId));
      const added = people.filter((u) => !before.includes(u));
      const removed = before.filter((u) => !people.includes(u));
      if (added.length) unwrap(await supabase().from("snow_site_people").insert(added.map((user_id) => ({ company_id: company.id, job_id: jobId, user_id }))));
      if (removed.length) unwrap(await supabase().from("snow_site_people").delete().eq("job_id", jobId).in("user_id", removed));
    },
    onSuccess: done,
  });
  const remove = useMutation({
    meta: { inline: true, success: "No longer a snow customer" },
    mutationFn: async () => unwrap(await supabase().from("snow_sites").delete().eq("job_id", site!.job_id)),
    onSuccess: done,
  });
  const askRemove = async () => {
    const ok = await confirm({ title: "Stop treating this as a snow customer?", body: "Nobody is told about snow for it any more. The job, its crew, its visits and its storm log stay as they are.", confirmLabel: "Remove", danger: true });
    if (ok) remove.mutate();
  };
  const setTier = (i: number, change: Partial<{ upTo: string; price: string }>) => setTiers(tiers.map((t, n) => (n === i ? { ...t, ...change } : t)));

  return (
    <Dialog open onClose={onClose} title={site ? customer(site) : "Add snow customer"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {site ? (
          <p className="muted small" style={{ marginTop: 0 }}>
            <Link to={`/jobs/${site.job_id}`}>Job #{site.job.number}</Link> · {site.job.title}{addressLine(site.job.property) ? ` · ${addressLine(site.job.property)}` : ""}
          </p>
        ) : (
          <Field label="Job" hint={<>A snow customer is one of your jobs. Don't see it? <Link to="/jobs?new=1">Create the job</Link> first.</>}>
            <input className="input" placeholder="Find the job" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Find the job" />
            <div className="card" style={{ maxHeight: 200, overflowY: "auto", boxShadow: "none", marginTop: 8 }}>
              {jobs.isPending && <div className="card-row"><Skeleton width="60%" /></div>}
              {shown.map((j) => (
                <label key={j.id} className="card-row" style={{ cursor: "pointer" }}>
                  <input type="radio" name="snow-job" checked={jobId === j.id} onChange={() => { setJobId(j.id); setCrewId(j.default_crew_id ?? ""); }} />
                  <span className="grow"><strong>{j.client?.display_name ?? j.title}</strong><span className="muted small" style={{ display: "block" }}>Job #{j.number} · {j.title}</span></span>
                </label>
              ))}
              {jobs.data && !shown.length && <EmptyState inline title={term ? "No active jobs match" : "Every active job is a snow customer already"} />}
            </div>
          </Field>
        )}
        <div className="form-grid form-grid-3">
          <Field label="Plow at" hint="Inches forecast from 6pm through the next day.">
            <div className="input-group">
              <input className="input" type="number" inputMode="decimal" min={0.1} max={48} step={0.1} value={trigger} onChange={(e) => setTrigger(e.target.value)} required />
              <span className="addon addon-right addon-unit">in</span>
            </div>
          </Field>
          <Field label="Salt at" optional hint="Less snow than that, and for ice or a refreeze.">
            <div className="input-group">
              <input className="input" type="number" inputMode="decimal" min={0.1} max={48} step={0.1} value={salt} onChange={(e) => setSalt(e.target.value)} placeholder="No salting" />
              <span className="addon addon-right addon-unit">in</span>
            </div>
          </Field>
          <Field label="Push again every" optional hint="In a long storm, past the trigger.">
            <div className="input-group">
              <input className="input" type="number" inputMode="decimal" min={0.1} max={48} step={0.1} value={repeat} onChange={(e) => setRepeat(e.target.value)} placeholder="One push" />
              <span className="addon addon-right addon-unit">in</span>
            </div>
          </Field>
        </div>
        <div className="form-grid form-grid-3">
          <Field label="Clear by" optional hint="A time of day you've promised.">
            <input className="input" type="time" value={clearBy} onChange={(e) => setClearBy(e.target.value)} />
          </Field>
          <Field label="Priority" hint="Who's told about first.">
            <select className="select" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Crew" hint="Its lead and members are told.">
            <select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">No crew</option>
              {(crews.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Other people on it" hint="A sub, or anyone on no crew who works this property. They're told too, and put on the visit when you schedule it. A sub is also asked whether they can go out.">
          <div className="card" style={{ maxHeight: 160, overflowY: "auto", boxShadow: "none" }}>
            {team.map((m) => (
              <label key={m.user_id} className="card-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={people.includes(m.user_id)} onChange={(e) => setPeople(e.target.checked ? [...people, m.user_id] : people.filter((u) => u !== m.user_id))} />
                <span className="grow">{nameOf(m)}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="What a storm bills" hint="By how much fell: the storm's first visit bills this, and more pushes that day are included. With no prices here, each push bills the job's own lines.">
          <div style={{ display: "grid", gap: 8 }}>
            {tiers.map((t, i) => (
              <div key={i} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="muted small">Up to</span>
                <div className="input-group" style={{ width: 120 }}>
                  <input className="input" type="number" inputMode="decimal" min={0.1} max={100} step={0.1} value={t.upTo} onChange={(e) => setTier(i, { upTo: e.target.value })} placeholder="any" aria-label={`Storm price ${i + 1}: up to how many inches`} />
                  <span className="addon addon-right addon-unit">in</span>
                </div>
                <div className="input-group" style={{ width: 130 }}>
                  <span className="addon">$</span>
                  <input className="input" type="number" inputMode="decimal" min={0} step={0.01} value={t.price} onChange={(e) => setTier(i, { price: e.target.value })} aria-label={`Storm price ${i + 1}: price`} />
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTiers(tiers.filter((_, n) => n !== i))}>Remove</Button>
              </div>
            ))}
            {tiers.length < 8 && <div><Button size="sm" icon="plus" onClick={() => setTiers([...tiers, { upTo: "", price: "" }])}>{tiers.length ? "Add another depth" : "Price storms by depth"}</Button></div>}
          </div>
        </Field>
        <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="checkbox" checked={tellClient} onChange={(e) => setTellClient(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <strong>Tell the client</strong>
            <span className="muted small" style={{ display: "block" }}>They get a message when their storm is scheduled and when each visit is done. The wording is yours to change in <Link to="/automations">Automations</Link>.</span>
          </span>
        </label>
        <FormError error={save.error ?? remove.error} />
        <div className="form-actions">
          {site && <Button variant="ghost" onClick={askRemove} loading={remove.isPending}>Remove</Button>}
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{site ? "Save" : "Add"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
