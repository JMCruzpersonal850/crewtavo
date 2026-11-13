/**
 * "What clients say" on a quote in the Client Hub: the business's Google rating and count, and up
 * to three of its reviews (the server's quoteReviewsFor picks them, by first name and initial), when
 * it shows them on quotes (Marketing → Reviews). Nothing without any.
 */
import { formatDate } from "@/lib/format";
import type { HubReviews as Reviews } from "./document";

export function HubReviews({ reviews }: { reviews: Reviews | null | undefined }) {
  if (!reviews || (!reviews.reviews.length && !reviews.count)) return null;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="hub-reviews">
      <h2 id="hub-reviews" className="hub-step-title">What clients say</h2>
      {reviews.rating !== null && Boolean(reviews.count) && (
        <span>
          <span style={{ color: "var(--req)" }} aria-hidden="true">★</span> <strong>{reviews.rating.toFixed(1)}</strong> on Google ·{" "}
          {reviews.count!.toLocaleString("en-US")} {reviews.count === 1 ? "review" : "reviews"}
        </span>
      )}
      {reviews.reviews.map((r, i) => (
        <figure key={i} className="stack-sm" style={{ gap: 2, margin: 0, paddingTop: 10, borderTop: "1px solid var(--divider)" }}>
          <span role="img" aria-label={`${r.rating} out of 5 stars`} style={{ color: "var(--req)", letterSpacing: 1 }}>{"★".repeat(r.rating)}</span>
          <blockquote style={{ margin: 0 }}>{r.text}</blockquote>
          <figcaption className="muted small">{r.name} · {formatDate(r.date)}</figcaption>
        </figure>
      ))}
    </section>
  );
}
