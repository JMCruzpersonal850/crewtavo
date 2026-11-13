/**
 * A quote's payment schedule on its paper and in the Client Hub (documents/build.ts quoteSchedule),
 * on the office's quote page (quotes/PaymentSchedule.tsx shownSchedule), and on its job
 * (jobs/JobPaymentSchedule.tsx): open, it follows the total; signed, it's what was kept with the
 * approval; on the job, each payment says where it is.
 */
import { describe, expect, it } from "vitest";
import { quoteDocument, quoteSchedule } from "@/features/documents/build";
import { canInvoiceNow, installmentState } from "@/features/jobs/JobPaymentSchedule";
import { shownSchedule } from "@/features/quotes/PaymentSchedule";
import { quoteForm } from "@/features/settings/QuoteSettings";

const rows = [
  { kind: "percent", value: 30, due: "approval" },
  { kind: "amount", value: 300, due: "date", on: "2027-03-01" },
  { kind: "rest", due: "work_done" },
];

describe("a quote's payment schedule as it prints", () => {
  it("works out an open quote's payments on the total shown", () => {
    expect(quoteSchedule({ payment_schedule: rows, approval: null, total: 1200 }, false)).toEqual([
      { name: "Payment 1", due: "When the quote is approved", amount: 360 },
      { name: "Payment 2", due: "On Mar 1, 2027", amount: 300 },
      { name: "Payment 3", due: "When the work is done", amount: 540 },
    ]);
  });

  it("prints a signed quote's payments as they were kept with the approval, whatever the quote says now", () => {
    const approval = { name: "Erin", payment_schedule: [{ ...rows[0], amount: 300 }, { ...rows[1], amount: 300 }, { ...rows[2], amount: 400 }] };
    expect(quoteSchedule({ payment_schedule: rows, approval, total: 5000 }, true)?.map((p) => p.amount)).toEqual([300, 300, 400]);
    // Signed before schedules were kept: none, rather than one worked out on today's total.
    expect(quoteSchedule({ payment_schedule: rows, approval: { name: "Erin" }, total: 5000 }, true)).toBeNull();
  });

  it("has none without a schedule, and from servers that don't send one", () => {
    expect(quoteSchedule({ payment_schedule: null, approval: null, total: 1000 }, false)).toBeNull();
    expect(quoteSchedule({ approval: null, total: 1000 }, false)).toBeNull();
  });

  it("takes the deposit's place on the paper", () => {
    const data = quoteDocument({ number: 7, subtotal: 1000, discount_amount: 0, tax_amount: 0, total: 1000, deposit_amount: 300, deposit_percent: 30, payment_schedule: rows, status: "sent" }, []);
    expect(data.schedule?.map((p) => p.amount)).toEqual([300, 300, 400]);
    expect(data.deposit).toBe(300);
  });
});

describe("the office's quote page", () => {
  it("shows the payments on the total, and says when they no longer fit it", () => {
    const fits = shownSchedule({ id: "q", status: "draft", total: 1000, payment_schedule: rows });
    expect(fits).toMatchObject({ fits: true, signed: false });
    const over = shownSchedule({ id: "q", status: "draft", total: 500, payment_schedule: [{ kind: "amount", value: 400, due: "approval" }, { kind: "amount", value: 400, due: "work_done" }] });
    expect(over).toMatchObject({ fits: false, left: -300 });
    expect(over.rows.map((r) => r.amount)).toEqual([400, 100]);
  });

  it("shows a signed quote's payments as signed", () => {
    const signed = shownSchedule({ id: "q", status: "converted", total: 9999, payment_schedule: rows, approval: { payment_schedule: [{ ...rows[2], amount: 1000 }] } });
    expect(signed).toMatchObject({ fits: true, signed: true });
    expect(signed.rows.map((r) => r.amount)).toEqual([1000]);
  });

  it("reads the company's switch to send scheduled payments by themselves, off unless it's on", () => {
    expect(quoteForm({}).sendPayments).toBe(false);
    expect(quoteForm({ payment_schedule: { send: true } }).sendPayments).toBe(true);
    expect(quoteForm(null).sendPayments).toBe(false);
  });
});

describe("the job's payments", () => {
  const invoice = (status: string) => ({ id: "i1", number: 12, status, total: 300 });
  const final = { id: "f1", number: 15 };

  it("says where each payment is", () => {
    expect(installmentState({ invoice: invoice("paid") }, null)).toEqual({ kind: "invoiced", invoice: invoice("paid") });
    expect(installmentState({ invoice: invoice("void") }, null)).toEqual({ kind: "voided", invoice: invoice("void") });
    expect(installmentState({ invoice: null }, null)).toEqual({ kind: "to_come" });
    // Once the final invoice is made, what's not invoiced is on it.
    expect(installmentState({ invoice: null }, final)).toEqual({ kind: "final", invoice: final });
    expect(installmentState({ invoice: invoice("void") }, final)).toEqual({ kind: "final", invoice: final });
    expect(installmentState({ invoice: invoice("sent") }, final)).toEqual({ kind: "invoiced", invoice: invoice("sent") });
  });

  it("offers Invoice now for a payment to come or voided, never for the final invoice's own", () => {
    expect(canInvoiceNow({ due: "date" }, { kind: "to_come" })).toBe(true);
    expect(canInvoiceNow({ due: "by_hand" }, { kind: "voided", invoice: invoice("void") })).toBe(true);
    expect(canInvoiceNow({ due: "work_done" }, { kind: "to_come" })).toBe(false);
    expect(canInvoiceNow({ due: "approval" }, { kind: "invoiced", invoice: invoice("sent") })).toBe(false);
    expect(canInvoiceNow({ due: "date" }, { kind: "final", invoice: final })).toBe(false);
  });
});
