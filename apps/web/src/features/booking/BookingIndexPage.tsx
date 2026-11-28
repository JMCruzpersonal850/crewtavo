/** The business's booking page (/book/:company): what it offers, before any one form. A visitor
 * picks what they came for — an estimate, a service, a plain request — and lands on that form,
 * the way Lead Control's booking page starts by asking what the visit is for. With only one form
 * on, the page is that form. No account needed. */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, kit as k } from "../public/ClientKit";
import s from "./bookingIndex.module.css";
import { postToHost } from "./embed";

interface FormChoice {
  slug: string;
  name: string;
  kind: string;
  pick_time: boolean;
  requires_approval: boolean;
}
interface IndexView {
  company: { name: string; phone: string | null; logo?: string | null; color?: string | null; privacy_url?: string | null };
  forms: FormChoice[];
}

/** The line under a form's name: what picking it does, in the visitor's words. */
export function formBlurb(form: Pick<FormChoice, "kind" | "pick_time" | "requires_approval">): string {
  if (form.pick_time) return form.requires_approval ? "Pick a time — we'll confirm it with you" : "Pick a time and you're booked";
  if (form.kind === "booking") return "Book a service";
  if (form.kind === "assessment") return "Ask us to come out and take a look";
  return "Send us a request";
}

export function BookingIndexPage() {
  const { company = "" } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get("embed") === "1";
  const page = useFitFrame(embedded);
  const view = useQuery({
    queryKey: ["booking-index", company],
    retry: false,
    queryFn: () => publicFetch<IndexView>(`/public/forms/${encodeURIComponent(company)}`),
  });
  useEffect(() => {
    if (view.data) document.title = `Book with ${view.data.company.name}`;
  }, [view.data]);

  const only = view.data?.forms.length === 1 ? view.data.forms[0]! : null;
  if (only) return <Navigate to={`/book/${encodeURIComponent(company)}/${encodeURIComponent(only.slug)}${params.size ? `?${params}` : ""}`} replace />;

  return (
    <ClientPage color={view.data?.company.color} embedded={embedded} pageRef={page}>
      {view.data && <ClientHeader name={view.data.company.name} logo={view.data.company.logo} phone={view.data.company.phone} sub="Book online" />}
      <ClientBody>
        {view.isPending && <ClientSkeleton lines={3} />}
        {view.error && <Broken title="This page isn't working">{(view.error as Error).message}</Broken>}
        {view.data && !view.data.forms.length && (
          <Broken title="Nothing to book here yet" icon="calendar">
            {view.data.company.name} isn't taking bookings online right now.
            {view.data.company.phone && <> Call <a className={k.link} href={`tel:${view.data.company.phone}`}>{view.data.company.phone}</a> and we'll sort it out.</>}
          </Broken>
        )}
        {view.data && view.data.forms.length > 1 && (
          <section className={k.card} aria-labelledby="book-title">
            <h1 id="book-title" className={k.titleMd}>What can we do for you?</h1>
            <ul className={s.choices}>
              {view.data.forms.map((form) => (
                <li key={form.slug}>
                  <Link className={s.choice} to={`/book/${encodeURIComponent(company)}/${encodeURIComponent(form.slug)}${params.size ? `?${params}` : ""}`}>
                    <span className={s.choiceText}>
                      <span className={s.choiceName}>{form.name}</span>
                      <span className={s.choiceBlurb}>{formBlurb(form)}</span>
                    </span>
                    <Icon name="chevronRight" size={18} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {view.data && <PrivacyFooter url={view.data.company.privacy_url} />}
      </ClientBody>
    </ClientPage>
  );
}

/** In an iframe on the business's website: keeps the frame as tall as the page (embed.ts), as the form page does. */
function useFitFrame(embedded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = ref.current;
    if (!embedded || !page) return;
    const observer = new ResizeObserver(() => postToHost({ crewtavo: "height", height: page.getBoundingClientRect().height }));
    observer.observe(page);
    return () => observer.disconnect();
  }, [embedded]);
  return ref;
}
