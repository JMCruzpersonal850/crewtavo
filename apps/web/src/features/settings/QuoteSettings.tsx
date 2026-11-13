/**
 * Settings → Company → Quotes and payments: the company's switches for its quotes, saved on their
 * own (merge_company_settings), so they never undo a change made elsewhere meanwhile.
 *   settings.payment_schedule.send   a scheduled payment's invoice goes to the client by itself
 *                                    (services/installments.ts), off unless set
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

interface QuoteForm {
  sendPayments: boolean;
}

/** The form's values from the company's settings. */
export function quoteForm(settings: unknown): QuoteForm {
  const s = (settings ?? {}) as Record<string, any>;
  return { sendPayments: s.payment_schedule?.send === true };
}

export function QuoteSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id],
    queryFn: async () => unwrap(await supabase().from("companies").select("name, slug, phone, email, website, address, timezone, currency, settings, trade_preset").eq("id", company.id).single()),
  });
  const [f, setF] = useState<QuoteForm | null>(null);
  useEffect(() => {
    if (details.data && !f) setF(quoteForm(details.data.settings));
  }, [details.data, f]);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (v: QuoteForm) => {
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: { payment_schedule: { send: v.sendPayments } } as never }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const saved = useJustDone(save);
  if (!f) return null;
  return (
    <form className="card card-pad stack" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      <strong>Quotes and payments</strong>
      <label className="switch-row" style={{ fontWeight: 400 }}>
        <input type="checkbox" className="switch" checked={f.sendPayments} onChange={(e) => setF({ ...f, sendPayments: e.target.checked })} />
        Send scheduled payments to clients by themselves
      </label>
      <span className="muted small">
        A quote's payment schedule becomes invoices on its job as each payment comes due. Off, each one waits in Drafts and the people who handle invoices are told. On, it's sent to the client the usual way, and they're told only if it couldn't be sent.
      </span>
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save</Button>
      </div>
    </form>
  );
}
