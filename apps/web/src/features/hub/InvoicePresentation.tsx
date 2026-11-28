/**
 * An invoice's head in the Client Hub, in Lead Control's shape (the same shape as a painting
 * proposal's, PaintProposal.tsx): a branded band with the invoice number, its issued date and
 * where it stands, a title block, and three info cards — who it's billed to, the company, and
 * the balance with when it's due.
 *
 * Presentation only: the balance and whether it's late are worked out by InvoiceHub (its own
 * money math, unchanged) and passed in; this only renders them.
 */
import { formatDate, formatMoneyCents } from "@/lib/format";
import type { InvoiceView } from "./document";
import styles from "./InvoicePresentation.module.css";

export function InvoiceHead({ data, balance, late }: { data: InvoiceView; balance: number; late: boolean }) {
  const inv = data.invoice;
  const company = data.company;
  const writtenOff = inv.status === "written_off";
  const status = writtenOff ? "Written off" : balance <= 0 ? "Paid in full" : late ? "Past due" : "Open";
  const dueLine = writtenOff ? "Written off" : balance <= 0 ? "Paid in full" : inv.due_on ? `Due ${formatDate(inv.due_on)}` : "Due on receipt";

  return (
    <div className={styles.head}>
      {/* The branded band: the document, its issued date and where it stands. */}
      <section className={styles.band} aria-label={`Invoice ${inv.number}`}>
        <div className={styles.bandMain}>
          <span className={styles.bandWord}>Invoice #{inv.number}</span>
          {inv.issued_on && <span className={styles.bandDate}>{formatDate(inv.issued_on)}</span>}
        </div>
        <span className={styles.pill}>{status}</span>
      </section>

      <div className={styles.titleBlock}>
        <h1 className={styles.title}>{inv.subject ?? "Invoice"}</h1>
        {inv.client?.display_name && <p className={styles.titleLine}>{inv.client.display_name}</p>}
      </div>

      <div className={styles.infoGrid}>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Billed to</span>
          <strong>{inv.client?.display_name ?? "—"}</strong>
        </div>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Company</span>
          <strong>{company.name}</strong>
          {(company.address ?? []).map((line) => <span key={line}>{line}</span>)}
          {company.phone && <span>{company.phone}</span>}
          {company.email && <span>{company.email}</span>}
          {company.website && <span>{company.website}</span>}
        </div>
        <div className={styles.infoCard}>
          <span className={styles.infoKick}>Balance</span>
          <strong className={styles.balanceAmount}>{formatMoneyCents(balance)}</strong>
          <span>{dueLine}</span>
        </div>
      </div>
    </div>
  );
}
