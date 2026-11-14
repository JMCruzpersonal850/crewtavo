/** What the Snow screens share: the snow customers as they load them, and how they word things. */
import type { SnowRules, SnowTier } from "@crewtavo/core/snow";
import { supabase, unwrap } from "@/lib/api";

export { inchesText as inches } from "@crewtavo/core/snow";

const FIELDS =
  "job_id, trigger_in, salt_trigger_in, repeat_in, clear_by, priority, tiers, tell_client, alerted_on, alerted_pushes, job:jobs!inner(id, number, title, status, paused_at, default_crew_id, client:clients(display_name), property:properties(line1, city, lat, lng), crew:crews(name, lead_user_id, members:crew_members(user_id))), people:snow_site_people(user_id)";

/** The business's snow customers: its active jobs the Snow page keeps triggers for. */
export const loadSites = async (companyId: string) =>
  unwrap(await supabase().from("snow_sites").select(FIELDS).eq("company_id", companyId).eq("job.status", "active").limit(1000));
export type Site = Awaited<ReturnType<typeof loadSites>>[number];

export const sitesKey = (companyId: string) => ["snow", companyId, "sites"] as const;

export const customer = (s: Pick<Site, "job">) => s.job.client?.display_name ?? s.job.title;
/** Its property is on the map, so its forecast can be checked. */
export const located = (s: Site) => s.job.property?.lat != null && s.job.property.lng != null;
export const rulesOf = (s: Pick<Site, "trigger_in" | "salt_trigger_in" | "repeat_in">): SnowRules => ({
  trigger_in: Number(s.trigger_in),
  salt_trigger_in: s.salt_trigger_in == null ? null : Number(s.salt_trigger_in),
  repeat_in: s.repeat_in == null ? null : Number(s.repeat_in),
});
/** The storm price tiers as saved (JSON the office edits), with anything that isn't one left out. */
export const tiersOf = (s: Pick<Site, "tiers">): SnowTier[] =>
  (Array.isArray(s.tiers) ? s.tiers : []).flatMap((t) => {
    const tier = t as { up_to_in?: unknown; price?: unknown } | null;
    return tier && typeof tier.price === "number" ? [{ up_to_in: typeof tier.up_to_in === "number" ? tier.up_to_in : null, price: tier.price }] : [];
  });

export interface Member { user_id: string; active: boolean; profile: { full_name: string } | null; sub?: { name: string } }
export const nameOf = (m: Member | undefined) => (m ? `${m.profile?.full_name || "Someone"}${m.sub ? ` (${m.sub.name})` : ""}` : "Someone who left");
export const PRIORITIES = [{ value: 1, label: "First" }, { value: 2, label: "Normal" }, { value: 3, label: "After the others" }] as const;
