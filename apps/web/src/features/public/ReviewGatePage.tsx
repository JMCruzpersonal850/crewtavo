/**
 * The review gate (/r/:token): where a review link lands. The client says how it went first —
 * 4-5 stars go on to the business's public review page; 1-3 stars stay private: the client
 * tells the business what went wrong instead (POST /public/r/:token/feedback → review_feedback,
 * which the office reads in Marketing → Reviews). Opening this page is the ask's open, so its
 * reminders stop here exactly like they did at the old straight-to-the-review-page redirect.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { linkToken } from "@/lib/linkToken";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "./ClientKit";
import styles from "./reviewGate.module.css";

type Gate = { company: string; logo: string | null; color: string | null; review_url: string; privacy_url?: string | null };

const STAR_WORDS = ["", "Poor", "Fair", "Okay", "Good", "Excellent"];

export function ReviewGatePage() {
  const { token: raw = "" } = useParams();
  const token = linkToken(raw);
  const gate = useQuery({
    queryKey: ["review-gate", token],
    retry: false,
    queryFn: () => publicFetch<Gate>(`/public/r/${token}/gate`),
  });
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const send = useMutation({
    mutationFn: () => publicFetch<{ ok: true }>(`/public/r/${token}/feedback`, { stars, comment: comment.trim() }),
  });
  useEffect(() => {
    document.title = "How did we do?";
  }, []);

  const data = gate.data;
  return (
    <ClientPage color={data?.color}>
      {data && <ClientHeader name={data.company} logo={data.logo} sub="Your feedback" />}
      <ClientBody width="narrow">
        {gate.isPending ? (
          <ClientSkeleton lines={1} />
        ) : gate.error ? (
          <Broken title="This link isn't working">{(gate.error as Error).message}</Broken>
        ) : !data ? (
          <Broken title="This link isn't working">This review link couldn't be loaded.</Broken>
        ) : send.isSuccess ? (
          <Done title="Thanks for telling us">
            <p className={k.doneText}>{data.company} reads every note like this and will follow up if there's something to put right. It stays between you and them — nothing is posted publicly.</p>
          </Done>
        ) : (
          <section className={`${k.card} ${styles.gate}`}>
            <h1 className={k.doneTitle}>How did {data.company} do?</h1>
            <p className={k.doneText}>Tap a star — it only takes a moment.</p>
            <div className={styles.stars} role="radiogroup" aria-label="Your rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={stars === n}
                  aria-label={`${n} star${n > 1 ? "s" : ""} — ${STAR_WORDS[n]}`}
                  className={styles.star}
                  data-on={n <= stars || undefined}
                  onClick={() => setStars(n)}
                >
                  <Icon name="star" size={36} filled={n <= stars} />
                </button>
              ))}
            </div>
            {stars > 0 && <p className={styles.word} aria-live="polite">{STAR_WORDS[stars]}</p>}
            {stars >= 4 && (
              <>
                <p className={k.doneText}>Glad to hear it. The best way to help {data.company} is a public review — it takes about a minute.</p>
                <a className={k.cta} href={data.review_url}>Leave a review</a>
              </>
            )}
            {stars >= 1 && stars <= 3 && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  send.mutate();
                }}
              >
                <p className={k.doneText}>Sorry to hear that. Tell {data.company} what went wrong — this goes only to them, never to a public review page.</p>
                <Field label="What happened?">
                  <textarea className="textarea" rows={4} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What could they have done better?" />
                </Field>
                <Button type="submit" className={k.cta} loading={send.isPending}>Send to {data.company}</Button>
                <FormError error={send.error} />
              </form>
            )}
          </section>
        )}
        <div className={k.foot}><PrivacyFooter url={data?.privacy_url} /></div>
      </ClientBody>
    </ClientPage>
  );
}
