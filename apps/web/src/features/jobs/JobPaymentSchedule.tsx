/**
 * "Payment schedule" on a job made from a quote that had one (job_installments,
 * 20261113001100_payment_schedules.sql): each payment, when it's due, and where it is: to come, its
 * invoice (and whether it's paid), or on the final invoice. The office can invoice one early, or
 * again after its invoice was voided ("Invoice now"); the database makes each once, so pressing it
 * twice says which invoice it's on.
 */
import { scheduleDueText, schedulePaymentName } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoneyCents } from "@/lib/format";

export interface InstallmentRow {
  id: string;
  position: number;
  count: number;
  due: "approval" | "date" | "work_starts" | "work_done" | "by_hand";
  due_on: string | null;
  amount: number;
  problem: string | null;
  invoice: { id: string; number: number | null; status: string; total: number } | null;
}

export type InstallmentState =
  | { kind: "invoiced"; invoice: NonNullable<InstallmentRow["invoice"]> }
  | { kind: "final"; invoice: { id: string; number: number | null } }
  | { kind: "voided"; invoice: NonNullable<InstallmentRow["invoice"]> }
  | { kind: "to_come" };

/**
 * Where a payment is: its invoice; voided (to invoice again by hand); on the job's final invoice,
 * which bills what's left once it's made; or still to come.
 */
export function installmentState(row: Pick<InstallmentRow, "invoice">, finalInvoice: { id: string; number: number | null } | null): InstallmentState {
  if (row.invoice && row.invoice.status !== "void") return { kind: "invoiced", invoice: row.invoice };
  if (finalInvoice) return { kind: "final", invoice: finalInvoice };
  if (row.invoice) return { kind: "voided", invoice: row.invoice };
  return { kind: "to_come" };
}

/** Whether "Invoice now" is offered: not for the final invoice's own payment, and not once it's invoiced or on the final invoice. */
export const canInvoiceNow = (row: Pick<InstallmentRow, "due">, state: InstallmentState) => row.due !== "work_done" && (state.kind === "to_come" || state.kind === "voided");

export function JobPaymentSchedule({ jobId, finalInvoice }: { jobId: string; finalInvoice: { id: string; number: number | null } | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const rows = useQuery({
    queryKey: ["job", jobId, "installments"],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("job_installments")
          .select("id, position, count, due, due_on, amount, problem, invoice:invoices(id, number, status, total)")
          .eq("job_id", jobId)
          .order("position"),
      ) as unknown as InstallmentRow[],
  });
  const invoiceNow = useMutation({
    meta: { success: "Invoice created as a draft", tone: "invoice" },
    mutationFn: async (id: string) => unwrap(await supabase().rpc("invoice_installment", { p_installment: id })) as string,
    onSuccess: (invoiceId) => {
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate(`/invoices/${invoiceId}`);
    },
  });
  if (!rows.data?.length) return null;
  return (
    <div className="card card-pad stack-sm">
      <strong>Payment schedule</strong>
      {rows.data.map((row) => {
        const state = installmentState(row, finalInvoice);
        return (
          <div key={row.id} className="stack-sm" style={{ gap: 4, paddingTop: 6, borderTop: "1px solid var(--divider)" }}>
            <div className="row-between">
              <span className="small strong">{schedulePaymentName(row.position, row.count)}</span>
              <span className="tabular">{formatMoneyCents(row.amount)}</span>
            </div>
            <div className="row-between small">
              <span className="muted">{scheduleDueText({ due: row.due, on: row.due_on }, (iso) => formatDate(iso))}</span>
              {state.kind === "invoiced" ? (
                <span className="row" style={{ gap: 6 }}>
                  <Link to={`/invoices/${state.invoice.id}`}>Invoice #{state.invoice.number}</Link>
                  <EntityStatus kind="invoice" status={state.invoice.status} />
                </span>
              ) : state.kind === "final" ? (
                <Link to={`/invoices/${state.invoice.id}`}>On the final invoice #{state.invoice.number}</Link>
              ) : state.kind === "voided" ? (
                <span className="muted">Invoice #{state.invoice.number} was voided</span>
              ) : (
                <span className="muted">{row.due === "work_done" ? "The final invoice" : "To come"}</span>
              )}
            </div>
            {row.problem && state.kind !== "invoiced" && state.kind !== "final" && <span className="small text-danger">{row.problem}</span>}
            {canInvoiceNow(row, state) && (
              <Button size="sm" variant="ghost" style={{ justifySelf: "start" }} loading={invoiceNow.isPending && invoiceNow.variables === row.id} onClick={() => invoiceNow.mutate(row.id)}>
                {state.kind === "voided" ? "Invoice it again" : "Invoice now"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
