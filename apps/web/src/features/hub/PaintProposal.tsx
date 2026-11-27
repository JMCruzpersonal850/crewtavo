/**
 * A painting proposal's client page, in Lead Control's shape (phase 3): the branded band,
 * the three info cards, the offer-valid banner, the Overall Scope of Work, the What's
 * Included box with its price and checklist, the Detailed Scope of Work's room cards, the
 * Investment Summary, the Job Notes and the Terms & Conditions — the page a painting client
 * reads, and the page that prints. Only a painting proposal renders it (the server sends
 * quote.paint and each line's room only for a painting company); every other trade keeps the
 * Hub's own cards.
 *
 * Presentation only: the option picking, add-on ticking and signing stay OpenQuote's — this
 * takes the lines of the option being looked at, the add-ons ticked, the totals and the
 * deposit from it, and renders them. Money is totals only (the painting pack's locked
 * decision): a room shows its total, never a line's price.
 */
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { sanitizeContractHtml } from "@/lib/html";
import type { QuoteContract } from "../documents/build";
import { paintHighlights, paintNotes, paintRoomCards, paintScope, type HubLine, type HubOption, type QuoteView } from "./document";
import styles from "./PaintProposal.module.css";

/** The money the page shows, as the Hub works it out (OpenQuote's hubTotals; signed, the quote's own). */
export interface PaintTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

const STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  changes_requested: "Changes requested",
  approved: "Approved",
  converted: "Approved",
  lost: "Closed",
  archived: "Closed",
};

export function PaintProposalSections({ data, lines, chosen, onChoose, editable, option, totals, deposit, contract }: {
  data: QuoteView;
  /** The lines of the option being looked at (signed: the quote's lines, its picks kept). */
  lines: HubLine[];
  /** The add-ons ticked. */
  chosen: string[];
  /** Ticking an add-on, while the proposal is open (OpenQuote's setChosen). */
  onChoose?: (ids: string[]) => void;
  editable: boolean;
  /** The option being looked at (its highlights feed What's Included when none are written). */
  option: HubOption | null;
  totals: PaintTotals;
  /** The deposit to book, from the quote's own deposit mechanism (depositToBook). */
  deposit: number;
  contract: QuoteContract | null;
}) {
  const q = data.quote;
  const company = data.company;
  const word = data.doc_word ?? "Proposal";
  const scope = paintScope(data, lines, chosen);
  const notes = paintNotes(data);
  const highlights = paintHighlights(data, option);
  const rooms = paintRoomCards(lines, chosen);
  const address = q.property ? [q.property.line1, [q.property.city, q.property.region].filter(Boolean).join(", "), q.property.postal_code].filter(Boolean).join(" · ") : null;
  const [termsOpen, setTermsOpen] = useState(false);
  const terms = contract?.terms.trim() ?? "";
  const sections = contract?.sections ?? [];

  // An add-on ticked or unticked, a group being one choice among its lines (LinesCard's rule).
  const choose = (line: HubLine, on: boolean) => {
    if (!onChoose) return;
    const group = line.option_group;
    if (group) onChoose([...chosen.filter((id) => (lines.find((x) => x.id === id)?.option_group ?? null) !== group), line.id!]);
    else onChoose(on ? [...chosen, line.id!] : chosen.filter((x) => x !== line.id));
  };

  return (
    <div className={styles.page}>
      {/* The branded band: the document, its date and where it stands. The page's own header
          above already carries the company's mark and the print button. */}
      <section className={styles.band} aria-label={`${word} ${q.number}`}>
        <div className={styles.bandMain}>
          <span className={styles.bandWord}>{word} #{q.number}</span>
          {q.created_at && <span className={styles.bandDate}>{formatDate(q.created_at)}</span>}
        </div>
        <span className={styles.pill}>{STATUS_WORDS[q.status] ?? q.status}</span>
      </section>

      <div className={styles.titleBlock}>
        <h1 className={styles.title}>{q.title}</h1>
        <p className={styles.titleLine}>
          {q.client?.display_name}
          {address ? ` · ${address}` : ""}
        </p>
      </div>

      <div className={styles.infoGrid}>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Prepared for</span>
          <strong>{q.client?.display_name ?? "—"}</strong>
          {q.client?.email && <span>{q.client.email}</span>}
        </div>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Project location</span>
          <strong>{q.property?.line1 ?? "—"}</strong>
          {q.property?.city && <span>{[q.property.city, q.property.region].filter(Boolean).join(", ")}{q.property.postal_code ? ` ${q.property.postal_code}` : ""}</span>}
          <span>{q.title}</span>
        </div>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Company</span>
          <strong>{company.name}</strong>
          {(company.address ?? []).map((line) => <span key={line}>{line}</span>)}
          {company.phone && <span>{company.phone}</span>}
          {company.email && <span>{company.email}</span>}
          {company.website && <span>{company.website}</span>}
        </div>
      </div>

      {q.valid_until && (
        <p className={styles.validBanner}>
          <Icon name="clock" size={15} /> Offer valid until {formatDate(q.valid_until)}
        </p>
      )}

      {scope && (
        <section className={styles.card} aria-label="Overall scope of work">
          <h2 className={styles.cardTitle}>Overall Scope of Work</h2>
          <p className="pre-wrap">{scope}</p>
        </section>
      )}

      <section className={styles.card} aria-label="What's included">
        <h2 className={styles.cardTitle}>What's Included</h2>
        <div className={styles.included}>
          <div className={styles.priceBox}>
            <span className={styles.price}>{formatMoneyCents(totals.total)}</span>
            <span className={styles.priceNote}>{totals.tax > 0 ? `Includes ${formatMoneyCents(totals.tax)} tax` : "Before tax"}</span>
            {deposit > 0 && <span className={styles.priceDeposit}>Deposit: {formatMoneyCents(deposit)}</span>}
          </div>
          {highlights.length > 0 && (
            <ul className={styles.checks}>
              {highlights.map((h) => (
                <li key={h}><Icon name="check" size={15} bold />{h}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {rooms.length > 0 && (
        <section aria-label="Detailed scope of work">
          <h2 className={styles.sectionTitle}>Detailed Scope of Work</h2>
          {rooms.map((room) => (
            <article key={room.title} className={styles.roomCard}>
              <header className={styles.roomHead}>
                <div>
                  <h3 className={styles.roomName}>{room.title}</h3>
                  <span className={styles.roomMeta}>{room.count} {room.count === 1 ? "service" : "services"} inside{room.dimensions ? ` · ${room.dimensions}` : ""}</span>
                </div>
                <span className={styles.roomTotal}>Room Total {formatMoneyCents(room.total)}</span>
              </header>
              {room.lines.map((line) => {
                const ticked = chosen.includes(line.id ?? "");
                return (
                  <div key={line.id} className={styles.line} data-off={line.optional && !ticked || undefined}>
                    <div className={styles.lineMain}>
                      <strong>{line.name}</strong>
                      {line.description && <p className="pre-wrap">{line.description}</p>}
                      <details className={styles.lineDetails}>
                        <summary>Service details</summary>
                        <p>{Number(line.quantity).toLocaleString()} {line.unit} · {line.optional ? "Optional add-on" : "Included"}</p>
                      </details>
                    </div>
                    {line.optional && editable && onChoose && (
                      <label className={styles.linePick}>
                        <input
                          type={line.option_group ? "radio" : "checkbox"}
                          name={line.option_group ? `paint-choice-${line.option_group}` : undefined}
                          aria-label={line.option_group ? `Choose ${line.name}` : `Add ${line.name}`}
                          checked={ticked}
                          onChange={(e) => choose(line, e.target.checked)}
                        />
                        {line.option_group ? "Choose" : "Add"}
                      </label>
                    )}
                    {line.optional && !editable && <span className={styles.lineTag}>{ticked ? "Included" : "Not included"}</span>}
                  </div>
                );
              })}
            </article>
          ))}
        </section>
      )}

      <section className={styles.card} aria-label="Investment summary">
        <h2 className={styles.cardTitle}>Investment Summary</h2>
        <div className={styles.sumRow}><span>Subtotal</span><span>{formatMoneyCents(totals.subtotal)}</span></div>
        {totals.discount > 0 && <div className={styles.sumRow}><span>Discount</span><span>−{formatMoneyCents(totals.discount)}</span></div>}
        <div className={styles.sumRow}><span>Sales tax ({Number(q.tax_rate)}%)</span><span>{formatMoneyCents(totals.tax)}</span></div>
        <div className={styles.totalBanner}><span>Total Job Investment</span><strong>{formatMoneyCents(totals.total)}</strong></div>
        {deposit > 0 && <div className={styles.depositRow}><span>Initial Deposit</span><strong>{formatMoneyCents(deposit)}</strong></div>}
      </section>

      {notes && (
        <section className={styles.card} aria-label="Job notes">
          <h2 className={styles.cardTitle}>Job Notes</h2>
          <p className="pre-wrap">{notes}</p>
        </section>
      )}

      {contract && (terms || sections.length > 0) && (
        <section className={styles.card} aria-label="Terms and conditions">
          <h2 className={styles.cardTitle}>Terms &amp; Conditions</h2>
          {terms && <p className={`pre-wrap ${termsOpen ? "" : styles.termsClamp}`}>{terms}</p>}
          {termsOpen &&
            sections.map((s) => (
              <div key={s.id} className={styles.termsSection}>
                <h3>{s.title.trim() || "This section"}</h3>
                <div className="prose" dangerouslySetInnerHTML={{ __html: sanitizeContractHtml(s.html) }} />
              </div>
            ))}
          {(sections.length > 0 || terms.length > 400) && (
            <button type="button" className="hub-link no-print" onClick={() => setTermsOpen((open) => !open)} aria-expanded={termsOpen}>
              {termsOpen ? "Show less" : "View full terms"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The head of the signing step, in Lead Control's shape: "Ready to Get Started?", what
 * signing says the client agrees to, and the company's contact card. The form itself — name,
 * signature, the tick and the button — stays OpenQuote's, right under this.
 */
export function PaintAcceptIntro({ data, total }: { data: QuoteView; total: number }) {
  const q = data.quote;
  const company = data.company;
  const word = data.doc_word ?? "Proposal";
  return (
    <div className={styles.acceptIntro}>
      <h2 className={styles.acceptTitle}>Ready to Get Started?</h2>
      <p className={styles.acceptText}>
        By signing below, I{q.client ? `, ${q.client.display_name},` : ""} acknowledge that I have read and agree to the scope of work,
        terms and conditions, and total investment of {formatMoneyCents(total)} for this {word.toLowerCase()}.
      </p>
      <div className={styles.infoCard}>
        <span className={styles.infoKick}>Contact information</span>
        <strong>{company.name}</strong>
        {(company.address ?? []).map((line) => <span key={line}>{line}</span>)}
        {company.phone && <span>{company.phone}</span>}
        {company.email && <span>{company.email}</span>}
        {company.website && <span>{company.website}</span>}
      </div>
    </div>
  );
}
