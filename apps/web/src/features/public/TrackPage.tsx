/**
 * The client's live map of the crew on the way (/track/:token): where the crew's phone last
 * reported, how long the drive from there should take, and — said plainly — how old that report
 * is, because a phone browser can't report from the background (services/tracking.ts trackView
 * shapes the data; the page polls it while the crew is coming). The visit's own status decides
 * what shows, so a link outliving the drive says the crew arrived, never a stale place. No
 * account needed.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type Map as MapLibreMap, type Marker } from "maplibre-gl";
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "./ClientKit";
import { ageWords, etaWords } from "./trackWords";
import s from "./track.module.css";

interface TrackViewData {
  state: "en_route" | "waiting" | "arrived" | "stopped" | "ended";
  company: { name: string; phone: string | null; logo: string | null; color: string | null };
  visit: { title: string; address: string; destination: { lat: number; lng: number } | null };
  crew: { first_name: string } | null;
  ping: { lat: number; lng: number; at: string; age_seconds: number } | null;
  eta_minutes: number | null;
}

const OPENFREEMAP = "https://tiles.openfreemap.org/styles/liberty";

/**
 * The map itself: the crew's last reported place (a dot in the business's color) and the place
 * they're headed, framed together. It follows later reports by moving the crew's dot, without
 * reframing under the client. If the map can't load, it hides itself: the words still say
 * where things stand.
 */
function TrackMap({ ping, destination, color, crewLabel }: { ping: { lat: number; lng: number }; destination: { lat: number; lng: number } | null; color: string | null; crewLabel: string }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const crewMark = useRef<Marker | null>(null);
  const framed = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!box.current || map.current) return;
    let m: MapLibreMap;
    try {
      m = new maplibregl.Map({ container: box.current, style: OPENFREEMAP, center: [ping.lng, ping.lat], zoom: 13, attributionControl: { compact: true } });
    } catch {
      setFailed(true);
      return;
    }
    m.on("error", () => setFailed(true));
    map.current = m;
    const crewEl = document.createElement("div");
    crewEl.className = s.crewDot;
    if (color) crewEl.style.background = color;
    crewEl.title = crewLabel;
    crewMark.current = new maplibregl.Marker({ element: crewEl }).setLngLat([ping.lng, ping.lat]).addTo(m);
    if (destination) {
      const destEl = document.createElement("div");
      destEl.className = s.destDot;
      destEl.title = "Your place";
      new maplibregl.Marker({ element: destEl }).setLngLat([destination.lng, destination.lat]).addTo(m);
    }
    return () => {
      m.remove();
      map.current = null;
      crewMark.current = null;
      framed.current = false;
    };
    // Made once, when the page first has a place to show; later reports move the dot below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !crewMark.current) return;
    crewMark.current.setLngLat([ping.lng, ping.lat]);
    if (!framed.current) {
      framed.current = true;
      if (destination) m.fitBounds(new maplibregl.LngLatBounds([destination.lng, destination.lat], [ping.lng, ping.lat]), { padding: 56, maxZoom: 15, duration: 0 });
    }
  }, [ping.lat, ping.lng, destination]);

  if (failed) return null;
  return (
    <div>
      <div ref={box} className={s.map} role="img" aria-label={`Map: ${crewLabel}'s last reported place`} />
      <p className={s.legend}>
        <span><span className={s.legendCrew} style={color ? { background: color } : undefined} />{crewLabel}</span>
        {destination && <span><span className={s.legendDest} />Your place</span>}
      </p>
    </div>
  );
}

export function TrackPage() {
  const { token = "" } = useParams();
  const view = useQuery({
    queryKey: ["track", token],
    retry: false,
    queryFn: () => publicFetch<TrackViewData>(`/track/${token}`),
    // While the crew is coming, ask again every ten seconds; once they've arrived (or the
    // sharing stopped, or the visit ended) the answer won't change, so stop asking.
    refetchInterval: (query) => (query.state.data?.state === "en_route" || query.state.data?.state === "waiting" ? 10_000 : false),
  });
  const d = view.data;
  useEffect(() => {
    document.title = d ? `On the way · ${d.company.name}` : "On the way";
  }, [d]);

  // The age of the last report, ticking between polls so the honesty label never sits still.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (d?.state !== "en_route") return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [d?.state, d?.ping?.at]);
  const age = d?.ping ? Math.max(0, Math.round((now - Date.parse(d.ping.at)) / 1000)) : null;

  const crewName = d?.crew?.first_name ?? "Your crew";
  return (
    <ClientPage color={d?.company.color}>
      {d && <ClientHeader name={d.company.name} logo={d.company.logo} phone={d.company.phone} sub="Live tracking" />}
      <ClientBody>
        {view.isPending && <ClientSkeleton lines={2} />}
        {view.error && (
          <Broken icon="link" title="This tracking link doesn't work">
            {(view.error as { status?: number }).status === 404 ? "It has expired, or the visit it was for is gone. The business can send you a new one." : (view.error as Error).message}
          </Broken>
        )}
        {d?.state === "arrived" && (
          <Done icon="check" title="They're here">
            <p className={k.doneText}>Your crew has arrived and started the visit.</p>
          </Done>
        )}
        {d && d.state !== "arrived" && (
          <section className={k.card} aria-labelledby="track-title">
            <h1 id="track-title" className={cx(k.title, k.long)}>
              {d.state === "en_route" ? `${crewName} is on the way` : d.state === "waiting" ? "On the way" : d.state === "stopped" ? "Location sharing stopped" : "This visit isn't on its way"}
            </h1>
            {d.visit.address && <span className={k.place}><Icon name="pin" size={14} />{d.visit.title ? `${d.visit.title} · ` : ""}{d.visit.address}</span>}
            {d.state === "en_route" && (
              <>
                {d.eta_minutes != null && <p className={s.eta}>They're {etaWords(d.eta_minutes)}.</p>}
                {d.ping && <TrackMap ping={d.ping} destination={d.visit.destination} color={d.company.color} crewLabel={crewName} />}
                {age != null && (
                  <p className={s.updated}>
                    Updated {ageWords(age)}.
                    {age >= 180 && " Updates pause while the crew's app is closed, so this may not be their exact spot right now."}
                  </p>
                )}
              </>
            )}
            {d.state === "waiting" && (
              <p className={k.msg}>
                Your crew has set off{d.eta_minutes != null ? ` and expects to arrive in ${etaWords(d.eta_minutes).replace(/^about /, "")}` : ""}. Their live place will show here as soon as their phone reports it.
              </p>
            )}
            {d.state === "stopped" && <p className={k.msg}>The crew stopped sharing their live place for this trip. They're still on their way{d.eta_minutes != null ? ` — ${etaWords(d.eta_minutes)} when last reported` : ""}.</p>}
            {d.state === "ended" && <p className={k.msg}>The visit was cancelled or put back on the schedule. Call {d.company.name} if you'd like to know what's next.</p>}
          </section>
        )}
      </ClientBody>
    </ClientPage>
  );
}
