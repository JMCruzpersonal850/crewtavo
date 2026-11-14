/**
 * How you compare (Marketing → Reviews): the business's Google rating and number of reviews next to
 * up to five nearby competitors', and how each count changed since the check before
 * (apps/api/src/services/reviewCompare.ts). Its own switch, off until an owner or admin turns it
 * on, checked with Google first. Competitors are found by name near the business, or picked from the
 * nearest of its trade. Checked weekly by itself, by hand at most once a day; what's shown is the
 * last check, so the card loads at once. The data is Google's, and says so.
 */
import { changeWords, countChange, MAX_COMPETITORS, ranked, standing, standingWords, type ComparedPlace } from "@crewtavo/core/reviewCompare";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";

interface Place extends ComparedPlace {
  place_id: string;
  address: string | null;
  maps_url: string | null;
}

interface CompareState {
  enabled: boolean;
  /** Whose Google key Places calls use: the server's, the company's (Settings → Maps), or none. */
  key: "server" | "company" | null;
  checked_at: string | null;
  next_check: string | null;
  last_error: string | null;
  places: Place[];
  can_switch: boolean;
}

interface Found {
  place_id: string;
  name: string;
  address: string | null;
  rating: number | null;
  ratings_total: number | null;
}

const stars = (rating: number | null) => (rating == null ? "—" : `${rating.toFixed(1)} ★`);

export function ReviewCompare() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["review-compare", session.company.id];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<CompareState>("/reviews/compare") });
  const [adding, setAdding] = useState(false);
  const set = (next: CompareState) => queryClient.setQueryData(key, (old: CompareState | undefined) => ({ ...next, can_switch: old?.can_switch ?? next.can_switch }));
  const toggle = useMutation({
    meta: { inline: true, success: (s: CompareState) => (s.enabled ? "Comparing with competitors on Google" : "Comparing is off") },
    mutationFn: (enabled: boolean) => api.put<CompareState>("/reviews/compare/enabled", { enabled }),
    onSuccess: set,
  });
  const refresh = useMutation({ meta: { inline: true, success: "Checked with Google" }, mutationFn: () => api.post<CompareState>("/reviews/compare/refresh"), onSuccess: set });
  const remove = useMutation({ meta: { inline: true }, mutationFn: (id: string) => api.delete<CompareState>(`/reviews/compare/places/${id}`), onSuccess: set });

  if (state.isPending) return <div className="card card-pad"><CardSkeleton lines={4} /></div>;
  if (state.error) return <div className="card"><ErrorState compact error={state.error} onRetry={() => state.refetch()} /></div>;
  const s = state.data;
  const places = [...s.places.filter((p) => p.is_own), ...ranked(s.places.filter((p) => !p.is_own))];
  const competitors = s.places.filter((p) => !p.is_own).length;
  const where = standing(s.places);
  const lastRead = s.places.map((p) => p.checked_at).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;

  return (
    <section className="card card-pad stack" aria-labelledby="review-compare">
      <div className="row-between wrap">
        <h2 id="review-compare" className="section-title" style={{ fontSize: 16 }}>How you compare</h2>
        {s.can_switch && (
          <label className="switch-row" style={{ gap: 8 }}>
            <span className="small">Compare on Google</span>
            <input type="checkbox" role="switch" className="switch" checked={toggle.isPending ? Boolean(toggle.variables) : s.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          </label>
        )}
      </div>
      {!s.enabled ? (
        <div className="stack-sm">
          <span className="muted small">
            See your Google rating and number of reviews next to up to five nearby competitors', and how many reviews each gets week to week. It uses Google Places with{" "}
            {s.key === "server" ? "the Google key this Crewtavo was set up with" : s.key === "company" ? <>your Google key from <Link to="/settings?tab=maps">Settings → Maps</Link></> : "a Google key"}: a few lookups a week, which Google may bill to the key's account.
          </span>
          {!s.key && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Add a Google key in <Link to="/settings?tab=maps">Settings → Maps</Link> first, with Places API (New) turned on for it, or ask whoever runs your Crewtavo to set one for the server.</span>}
          {!s.can_switch && <span className="muted small">An owner or admin can turn it on here.</span>}
          <FormError error={toggle.error} />
        </div>
      ) : (
        <>
          {s.last_error && <div className="callout callout-warning"><Icon name="alert" size={20} /><div className="grow">The last check didn't work: {s.last_error}</div></div>}
          {!places.length ? (
            <EmptyState icon="star" title="Pick who to compare with">Add your own business and up to five competitors from Google.</EmptyState>
          ) : (
            <div style={{ overflowX: "auto", margin: "0 -20px" }}>
              <table className="table">
                <thead><tr><th>Business</th><th style={{ textAlign: "right" }}>Rating</th><th style={{ textAlign: "right" }}>Reviews</th><th style={{ textAlign: "right" }}>Since last check</th><th aria-label="Remove" /></tr></thead>
                <tbody>
                  {places.map((p) => {
                    const change = countChange(p);
                    return (
                      <tr key={p.id} style={p.is_own ? { fontWeight: 700 } : undefined}>
                        <td>
                          {p.maps_url ? <a href={p.maps_url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}
                          {p.is_own && <span className="chip chip-green" style={{ marginLeft: 6 }}>You</span>}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{stars(p.rating)}</td>
                        <td style={{ textAlign: "right" }}>{p.ratings_total == null ? "—" : p.ratings_total.toLocaleString("en-US")}</td>
                        <td style={{ textAlign: "right", color: change && change > 0 ? "var(--green-dark)" : undefined }}>{changeWords(change) || <span className="muted">—</span>}</td>
                        <td style={{ textAlign: "right" }}><button type="button" className="icon-btn" aria-label={`Remove ${p.name}`} disabled={remove.isPending} onClick={() => remove.mutate(p.id)}><Icon name="x" size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {where && (
            <p className="small" style={{ margin: 0 }}>
              <strong>{standingWords(where)}</strong>
              {where.ratingVsAverage != null && ` · ${where.ratingVsAverage === 0 ? "the same rating as" : `${Math.abs(where.ratingVsAverage).toFixed(1)} ${where.ratingVsAverage > 0 ? "above" : "below"}`} the others' average`}
              {where.reviewsVsAverage != null && ` · ${Math.abs(where.reviewsVsAverage).toLocaleString("en-US")} ${where.reviewsVsAverage >= 0 ? "more" : "fewer"} reviews than their average`}
              {where.gained != null && where.averageGained != null && ` · you gained ${where.gained}, they gained ${where.averageGained} on average since the last check`}
            </p>
          )}
          {!s.places.some((p) => p.is_own) && places.length > 0 && <span className="muted small">Add your own business too, to see how you stand.</span>}
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" icon="plus" disabled={competitors >= MAX_COMPETITORS && s.places.some((p) => p.is_own)} onClick={() => setAdding(true)}>Add a business</Button>
            <Button size="sm" icon="refresh" loading={refresh.isPending} disabled={Boolean(s.next_check) || !places.length} onClick={() => refresh.mutate()}>Check now</Button>
          </div>
          <FormError error={refresh.error ?? remove.error ?? toggle.error} />
          <span className="muted small">
            {lastRead ? `Last checked ${formatDate(lastRead)}. ` : ""}Checked again every week{s.next_check ? `; by hand again after ${formatDate(s.next_check)}` : ""}. Ratings and reviews from Google Maps.
          </span>
        </>
      )}
      {adding && <AddPlaceDialog hasOwn={s.places.some((p) => p.is_own)} full={competitors >= MAX_COMPETITORS} onClose={() => setAdding(false)} onAdded={(next) => { set(next); setAdding(false); }} />}
    </section>
  );
}

function AddPlaceDialog({ hasOwn, full, onClose, onAdded }: { hasOwn: boolean; full: boolean; onClose: () => void; onAdded: (s: CompareState) => void }) {
  const [q, setQ] = useState("");
  const search = useMutation({ meta: { inline: true }, mutationFn: (text: string) => api.get<{ places: Found[] }>(`/reviews/compare/search?q=${encodeURIComponent(text)}`) });
  const suggest = useMutation({ meta: { inline: true }, mutationFn: () => api.get<{ places: Found[] }>("/reviews/compare/suggest") });
  const add = useMutation({ meta: { inline: true }, mutationFn: (p: { place_id: string; own: boolean }) => api.post<CompareState>("/reviews/compare/places", p), onSuccess: onAdded });
  const results = search.data?.places ?? suggest.data?.places ?? null;
  const busy = search.isPending || suggest.isPending;
  return (
    <Dialog open onClose={onClose} title="Add a business" description="Search Google for a competitor near you, or your own business." size="md">
      <div className="stack">
        <form className="row" style={{ gap: 8 }} onSubmit={(e: FormEvent) => { e.preventDefault(); if (q.trim().length >= 2) { suggest.reset(); search.mutate(q.trim()); } }}>
          <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Business name" maxLength={120} aria-label="Business name" autoFocus />
          <Button type="submit" icon="search" loading={search.isPending} disabled={q.trim().length < 2}>Search</Button>
        </form>
        <div><Button size="sm" variant="ghost" icon="pin" loading={suggest.isPending} onClick={() => { search.reset(); suggest.mutate(); }}>Suggest the nearest in my trade</Button></div>
        <FormError error={search.error ?? suggest.error ?? add.error} />
        {busy ? <Skeleton height={120} /> : results && (
          !results.length ? <span className="muted small">Nothing found. Try another name.</span> : (
            <div className="card">
              {results.map((p) => (
                <div key={p.place_id} className="card-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong className="ellipsis" style={{ display: "block" }}>{p.name}</strong>
                    <span className="muted small ellipsis" style={{ display: "block" }}>{[p.rating != null ? stars(p.rating) : null, p.ratings_total != null ? `${p.ratings_total.toLocaleString("en-US")} reviews` : null, p.address].filter(Boolean).join(" · ")}</span>
                  </div>
                  {!hasOwn && <Button size="sm" disabled={add.isPending} onClick={() => add.mutate({ place_id: p.place_id, own: true })}>This is us</Button>}
                  <Button size="sm" variant="primary" disabled={add.isPending || full} onClick={() => add.mutate({ place_id: p.place_id, own: false })}>Add</Button>
                </div>
              ))}
            </div>
          )
        )}
        {full && <span className="muted small">You're comparing with five competitors already. Remove one to add another.</span>}
        <span className="muted small">Results from Google Maps.</span>
      </div>
    </Dialog>
  );
}
