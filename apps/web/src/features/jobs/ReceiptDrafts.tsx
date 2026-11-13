/**
 * Several receipts or supplier invoices at once, for the office with job costs: each file dropped or
 * picked is uploaded to the receipts folder, becomes a draft (public.expense_drafts) and is read
 * (apps/api/src/routes/receipts.ts) when reading is on. The drafts wait in a list to be checked and
 * saved one by one as expenses (ExpenseDialog), or discarded. Until then nothing counts them: they
 * aren't expenses. On a job's Expenses, its own; on Finance → Profit, all of them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { uploadFile } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ExpenseDialog } from "./ExpensesCard";
import type { ReadAnswer } from "./receiptReading";

export interface ExpenseDraft {
  id: string;
  job_id: string | null;
  receipt_path: string;
  file_name: string | null;
  status: string;
  read: ReadAnswer | null;
  error: string | null;
  created_at: string;
  job?: { number: number | null; title: string } | null;
}

const draftsKey = (companyId: string, jobId?: string) => ["receipt-drafts", companyId, jobId ?? "all"];
/** A draft still being read after this long was cut off (a server restart): it can be read again. */
const STUCK_MS = 3 * 60_000;

/** The drafts waiting: a job's, or (no job) all of them. Asked again every few seconds while any is being read. */
export function useReceiptDrafts(jobId?: string) {
  const session = useSession();
  const seesCosts = hasRole(session, "admin", "office") && can(session, "job_costs");
  return useQuery({
    queryKey: draftsKey(session.company.id, jobId),
    enabled: seesCosts,
    refetchInterval: (q) => ((q.state.data as ExpenseDraft[] | undefined)?.some((d) => d.status === "reading" && Date.now() - Date.parse(d.created_at) < STUCK_MS) ? 4000 : false),
    queryFn: async () => {
      const rows = await everyRow(() => {
        const q = supabase().from("expense_drafts").select("id, job_id, receipt_path, file_name, status, read, error, created_at, job:jobs(number, title)").eq("company_id", session.company.id);
        return jobId ? q.eq("job_id", jobId) : q;
      }, { order: "created_at" });
      return rows as unknown as ExpenseDraft[];
    },
  });
}

export function ReceiptDrafts({ jobId, onSaved }: { jobId?: string; onSaved?: () => unknown }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const seesCosts = hasRole(session, "admin", "office") && can(session, "job_costs");
  const drafts = useReceiptDrafts(jobId);
  const [over, setOver] = useState(false);
  const [checking, setChecking] = useState<ExpenseDraft | null>(null);
  const [adding, setAdding] = useState(0);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["receipt-drafts", session.company.id] });

  const read = (id: string) => api.post(`/receipts/drafts/${id}/read`).catch(() => undefined).finally(() => void refresh());
  // Each file uploaded and made a draft, then read: two at a time, so a stack of them doesn't wait on one.
  const add = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setAdding((n) => n + list.length);
    const failed: string[] = [];
    const one = async (file: File) => {
      try {
        const receipt_path = await uploadFile(session.company.id, "receipts", file);
        const draft = unwrap(await supabase().from("expense_drafts").insert({ company_id: session.company.id, job_id: jobId ?? null, receipt_path, file_name: file.name.slice(0, 255) }).select("id").single());
        void refresh();
        await read(draft.id);
      } catch (error) {
        failed.push(`${file.name}: ${errorMessage(error)}`);
      } finally {
        setAdding((n) => n - 1);
      }
    };
    const queue = [...list];
    await Promise.all([0, 1].map(async () => { for (let f = queue.shift(); f; f = queue.shift()) await one(f); }));
    if (failed.length) toast.error(failed.length === 1 ? "A file couldn't be added" : `${failed.length} files couldn't be added`, { description: failed.join("\n") });
  };
  const discard = useMutation({
    meta: { success: "Receipt discarded" },
    mutationFn: async (id: string) => unwrap(await supabase().from("expense_drafts").delete().eq("id", id)),
    onSettled: refresh,
  });

  if (!seesCosts) return null;
  const rows = drafts.data ?? [];
  return (
    <div className="stack-sm">
      {rows.length > 0 && (
        <div className="card">
          <div className="card-row"><strong className="grow small">Receipts to check and save</strong><span className="muted small">{rows.length}</span></div>
          {rows.map((d) => {
            const r = d.read?.reading;
            const stuck = d.status === "reading" && Date.now() - Date.parse(d.created_at) >= STUCK_MS;
            const job = d.job ?? (d.read?.job ? { number: d.read.job.number, title: d.read.job.title } : null);
            return (
              <div key={d.id} className="card-row">
                <span className="n-icon" style={{ width: 36, height: 36, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-2)", color: "var(--text-3)", flex: "none" }}><Icon name="receipt" size={18} /></span>
                <span className="grow">
                  <strong>{r?.vendor || d.file_name || "Receipt"}</strong>
                  <span className="muted small" style={{ display: "block" }}>
                    {d.status === "reading" && !stuck ? "Reading…"
                      : d.status === "failed" || stuck ? "Couldn't be read: fill it in"
                        : [r?.total != null ? formatMoneyCents(r.total) : null, r?.date ? formatDate(r.date) : null, !jobId && job ? `Job #${job.number}${d.job ? "" : " (suggested)"}` : null, d.read?.problems.length ? `${d.read.problems.length} to check` : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Button size="sm" disabled={d.status === "reading" && !stuck} onClick={() => setChecking(d)}>Check and save</Button>
                <Menu
                  triggerClassName="btn btn-sm btn-ghost btn-icon"
                  label="Receipt actions"
                  items={[
                    { label: "Read again", icon: "refresh", hidden: !(d.status === "failed" || stuck), onSelect: () => void read(d.id) },
                    { label: "Discard", icon: "trash", danger: true, onSelect: () => discard.mutate(d.id) },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
      <label
        className="dropzone"
        style={{ padding: 12 }}
        data-over={over || undefined}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); }}
      >
        <Icon name="upload" size={18} />
        <span className="small strong">{adding > 0 ? `Adding ${adding}…` : "Drop several receipts or supplier invoices here, or click to choose"}</span>
        <span className="small muted">Photos or PDFs. Each waits here to be checked and saved: none counts in job costing until it is.</span>
        <input type="file" multiple accept="image/*,application/pdf" className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
      </label>
      {checking && (
        <ExpenseDialog
          jobId={jobId ?? null}
          expense={null}
          draft={checking}
          onClose={() => setChecking(null)}
          onSaved={async () => {
            await refresh();
            await onSaved?.();
          }}
        />
      )}
    </div>
  );
}
