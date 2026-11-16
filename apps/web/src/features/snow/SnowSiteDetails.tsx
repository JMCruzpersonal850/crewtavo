/**
 * A snow customer opened up, under its row on Snow → Storm and Customers: where it is (the address
 * opens the person's maps app), who to call, the notes its crew reads on a visit, its photos, and
 * its files, which are added here. How it's served is changed in Edit (SnowSiteDialog), by the
 * roles snow_sites lets write.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrapOne } from "@/lib/api";
import { placeText } from "@/lib/maps";
import { hasRole, useSession } from "@/lib/session";
import { PhotosCard } from "../files/PhotosCard";
import { PlansCard } from "../plans/PlansCard";
import { customer, located, type Site } from "./snowData";
import styles from "./SnowSiteDetails.module.css";

/** The customer's name in its row: the button that opens it up (the row itself does too). */
export function SiteName({ site, open, onToggle }: { site: Pick<Site, "job">; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={styles.name} aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      {customer(site)}
      <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
    </button>
  );
}

export function SnowSiteDetails({ site, colSpan, onEdit, onWeather }: { site: Site; colSpan: number; onEdit: () => void; onWeather?: () => void }) {
  const session = useSession();
  const more = useQuery({
    queryKey: ["snow", session.company.id, "details", site.job_id],
    queryFn: async () =>
      unwrapOne(await supabase().from("jobs").select("client:clients(id, phone), property:properties(id, line1, line2, city, region, postal_code, lat, lng, notes)").eq("id", site.job_id).maybeSingle(), "This job"),
  });
  const { client, property } = more.data ?? {};
  const address = property ? placeText(property) : "";
  return (
    <tr className={styles.details}>
      <td colSpan={colSpan}>
        <div className={styles.grid}>
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <strong>{customer(site)}</strong>
              {hasRole(session, "admin", "office") && <Button size="sm" icon="edit" onClick={onEdit}>Edit</Button>}
            </div>
            {more.isPending ? (
              <Skeleton width="70%" />
            ) : more.error ? (
              <ErrorState compact error={more.error} onRetry={() => more.refetch()} />
            ) : (
              <>
                {address ? <MapsLink place={property!}>{address}</MapsLink> : <span className="muted">No address on the job</span>}
                {client?.phone && <a href={`tel:${client.phone}`}>{client.phone}</a>}
                {property?.notes && <div className="small"><span className="muted">About the property</span><p className={`pre-wrap ${styles.plain}`}>{property.notes}</p></div>}
              </>
            )}
            {site.job.instructions ? (
              <div className="small"><span className="muted">Instructions for the crew</span><p className={`pre-wrap ${styles.note}`}>{site.job.instructions}</p></div>
            ) : (
              <span className="muted small">No instructions for the crew yet.</span>
            )}
            <div className="row wrap">
              <Link className="btn btn-sm" to={`/jobs/${site.job_id}`}>Job #{site.job.number}</Link>
              {client && <Link className="btn btn-sm" to={`/clients/${client.id}`}>Client</Link>}
              {onWeather && located(site) && <Button size="sm" icon="cloudSnow" onClick={onWeather}>Weather</Button>}
            </div>
          </div>
          <div className="stack">
            <PhotosCard jobId={site.job_id} />
            {/* Once the property is known, so its files from earlier work load with the job's. */}
            {more.data && <PlansCard scope={{ kind: "job", id: site.job_id, propertyId: property?.id ?? null }} />}
          </div>
        </div>
      </td>
    </tr>
  );
}
