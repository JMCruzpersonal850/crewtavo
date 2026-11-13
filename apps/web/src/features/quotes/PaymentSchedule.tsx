/**
 * "Payment schedule" on a quote (quotes.payment_schedule): how the client pays it, a row at a time,
 * each a percent of the total, an amount, or (the last one) the rest, and when it's due. The rows
 * have to come to the quote's total: the editor shows what's left and won't save until they do (the
 * database says the same: 20261113001100_payment_schedules.sql). The payment due at approval is the
 * deposit. A total that changes afterwards moves the percents; amounts that no longer fit are
 * flagged here. Once it's signed, it shows the amounts kept with the approval.
 */
import { SCHEDULE_DUE, scheduleAmounts, scheduleDueText, scheduleProblem, scheduleRows, type ScheduleDue, type ScheduleRow } from "@crewtavo/core/money";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoneyCents } from "@/lib/format";
import styles from "./QuotePage.module.css";

const DUE_LABELS: Record<ScheduleDue, string> = {
  approval: "When they approve",
  date: "On a date",
  work_starts: "When the work starts",
  work_done: "When the work is done",
  by_hand: "When we invoice it",
};

/** A row as it's typed: the amount as text, so a half-typed number isn't lost. */
interface DraftRow {
  kind: ScheduleRow["kind"];
  value: string;
  due: ScheduleDue;
  on: string;
}

const toDraft = (r: ScheduleRow): DraftRow => ({ kind: r.kind, value: r.value == null ? "" : String(r.value), due: r.due, on: r.on ?? "" });
/** As it's saved: numbers, a date only when it's due on one, no value for the rest. */
const fromDraft = (d: DraftRow): ScheduleRow => ({
  kind: d.kind,
  ...(d.kind === "rest" ? {} : { value: d.value.trim() === "" ? null : Number(d.value) }),
  due: d.due,
  ...(d.due === "date" ? { on: d.on || null } : {}),
});
/** Half when they approve, the rest when the work is done: the usual start. */
const STARTER: DraftRow[] = [
  { kind: "percent", value: "50", due: "approval", on: "" },
  { kind: "rest", value: "", due: "work_done", on: "" },
];

export interface ScheduleQuote {
  id: string;
  status: string;
  total: number | string | null;
  payment_schedule?: unknown;
  approval?: unknown;
  recurrence_rule?: string | null;
  change_order_for?: string | null;
}

/** The payments as they show: signed, as kept with the approval; open, worked out on the total. */
export function shownSchedule(quote: ScheduleQuote) {
  const signed = quote.status === "approved" || quote.status === "converted";
  if (signed) {
    const kept = scheduleRows(quote.approval && typeof quote.approval === "object" ? (quote.approval as { payment_schedule?: unknown }).payment_schedule : null);
    return { rows: kept.map((r) => ({ ...r, amount: Number((r as { amount?: unknown }).amount ?? 0) })), fits: true, left: 0, signed };
  }
  return { ...scheduleAmounts(scheduleRows(quote.payment_schedule), quote.total), signed };
}

export function PaymentScheduleCard({ quote, editable, onSaved }: { quote: ScheduleQuote; editable: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<DraftRow[] | null>(null);
  const shown = shownSchedule(quote);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (rows: ScheduleRow[] | null) => {
      unwrap(await supabase().from("quotes").update({ payment_schedule: rows as never }).eq("id", quote.id));
    },
    onSuccess: () => {
      setDraft(null);
      onSaved();
    },
  });
  // Repeating work is billed by the visit or the month, and a change order with its job.
  if (quote.recurrence_rule || quote.change_order_for) return null;
  if (!shown.rows.length && !editable && !draft) return null;

  if (draft) {
    const rows = draft.map(fromDraft);
    const sums = scheduleAmounts(rows, quote.total);
    const problem = scheduleProblem(rows, quote.total);
    const set = (i: number, change: Partial<DraftRow>) => setDraft(draft.map((d, n) => (n === i ? { ...d, ...change } : d)));
    return (
      <div className="card card-pad stack-sm">
        <strong>Payment schedule</strong>
        <p className="muted small">The payments have to come to the total, {formatMoneyCents(Number(quote.total ?? 0))}. The one due when they approve is the deposit.</p>
        {draft.map((d, i) => {
          const last = i === draft.length - 1;
          return (
            <div key={i} className={styles.scheduleRow}>
              <span className="small strong">Payment {i + 1}</span>
              <div className="row" style={{ gap: 6 }}>
                <select className="select input-sm" aria-label={`Payment ${i + 1} as`} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as DraftRow["kind"] })}>
                  <option value="percent">%</option>
                  <option value="amount">$</option>
                  {last && <option value="rest">The rest</option>}
                </select>
                {d.kind !== "rest" && (
                  <input className="input input-sm" style={{ width: 96, textAlign: "right" }} inputMode="decimal" aria-label={d.kind === "percent" ? `Payment ${i + 1} percent` : `Payment ${i + 1} amount`}
                    value={d.value} onChange={(e) => set(i, { value: e.target.value.replace(/[^0-9.]/g, "") })} />
                )}
                <span className="muted small tabular">{formatMoneyCents(sums.rows[i]?.amount ?? 0)}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <select className="select input-sm" aria-label={`Payment ${i + 1} due`} value={d.due} onChange={(e) => set(i, { due: e.target.value as ScheduleDue })}>
                  {SCHEDULE_DUE.map((due) => <option key={due} value={due}>{DUE_LABELS[due]}</option>)}
                </select>
                {d.due === "date" && <input className="input input-sm" type="date" aria-label={`Payment ${i + 1} date`} value={d.on} onChange={(e) => set(i, { on: e.target.value })} />}
                {draft.length > 1 && (
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove payment ${i + 1}`}
                    onClick={() => setDraft(draft.filter((_, n) => n !== i).map((r, n, all) => (n === all.length - 1 || r.kind !== "rest" ? r : { ...r, kind: "percent" })))} />
                )}
              </div>
            </div>
          );
        })}
        {draft.length < 12 && (
          <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }}
            onClick={() => setDraft([...draft.map((r) => (r.kind === "rest" ? { ...r, kind: "percent" as const } : r)), { kind: "rest", value: "", due: "work_done", on: "" }])}>
            Add a payment
          </Button>
        )}
        <div className="line"><span>{sums.left < 0 ? "Over the total by" : "Left to place"}</span><strong className="tabular">{formatMoneyCents(Math.abs(sums.left))}</strong></div>
        {problem && <p className={styles.warn} role="status">{problem}</p>}
        <FormError error={save.error} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" variant="primary" loading={save.isPending} disabled={Boolean(problem)} onClick={() => save.mutate(rows)}>Save schedule</Button>
          <Button size="sm" onClick={() => setDraft(null)}>Cancel</Button>
          {shown.rows.length > 0 && <Button size="sm" variant="ghost" onClick={() => save.mutate(null)}>Take the schedule off</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="card card-pad stack-sm">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Payment schedule</strong>
        {editable && <Button size="sm" variant="ghost" onClick={() => setDraft(shown.rows.length ? scheduleRows(quote.payment_schedule).map(toDraft) : STARTER)}>{shown.rows.length ? "Edit" : "Add"}</Button>}
      </div>
      {shown.rows.length ? (
        <>
          {shown.rows.map((r, i) => (
            <div key={i} className="line"><span>Payment {i + 1}: {scheduleDueText(r, (iso) => formatDate(iso))}</span><span className="tabular">{formatMoneyCents(r.amount)}</span></div>
          ))}
          {!shown.fits && (
            <p className={styles.warn} role="status">
              <Icon name="alert" size={14} /> The total changed, so these payments {shown.left > 0 ? `leave ${formatMoneyCents(shown.left)} out` : `come to ${formatMoneyCents(-shown.left)} more than it`}. The last one takes what's left: edit the schedule to change that.
            </p>
          )}
          {shown.signed && <p className="muted small">As it was approved. The job invoices each payment when it's due.</p>}
        </>
      ) : (
        <p className="muted small">One deposit, or payments over the job: when they approve, on a date, when the work starts or when it's done.</p>
      )}
    </div>
  );
}
