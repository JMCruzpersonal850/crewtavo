/**
 * Settings → Company → Quotes and payments: the company's switches for its quotes, saved on their
 * own (merge_company_settings), so they never undo a change made elsewhere meanwhile.
 *   settings.payment_schedule.send   a scheduled payment's invoice goes to the client by itself
 *                                    (services/installments.ts), off unless set
 *   settings.quotes.alert_over       "Tell me about quotes over $X": owners, admins and the quote's
 *                                    salesperson hear when one is sent, approved or sent back for
 *                                    changes (20261113001120_high_value_quote_alerts.sql); off empty
 */
import { toUnits } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

interface QuoteForm {
  sendPayments: boolean;
  /** The amount as typed; empty is off. */
  alertOver: string;
}

/** The form's values from the company's settings. */
export function quoteForm(settings: unknown): QuoteForm {
  const s = (settings ?? {}) as Record<string, any>;
  const over = Number(s.quotes?.alert_over);
  return { sendPayments: s.payment_schedule?.send === true, alertOver: typeof s.quotes?.alert_over === "number" && over > 0 ? String(over) : "" };
}

/** The alert amount to save: a number above 0 to the cent, null for off. Throws the field's message when it isn't one. */
export function alertAmount(typed: string): number | null {
  if (!typed.trim()) return null;
  const n = Number(typed);
  if (!(n > 0 && n <= 100_000_000)) throw new Error("Enter an amount above $0 for quote alerts, or leave it empty.");
  // Read as typed, so 2500.555 is $2,500.56 as the database rounds it.
  return Number(toUnits(typed, 2)) / 100;
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
      const settings = { payment_schedule: { send: v.sendPayments }, quotes: { alert_over: alertAmount(v.alertOver) } };
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: settings as never }));
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
      <Field label="Tell me about quotes over" optional hint="When a quote of at least this much is sent, approved, or the client asks for changes, owners, admins and its salesperson hear about it on the bell and their phone. Empty is off.">
        <span className="input-group" style={{ maxWidth: 180 }}>
          <span className="addon">$</span>
          <input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={f.alertOver} placeholder="Off" onChange={(e) => setF({ ...f, alertOver: e.target.value.replace(/[^0-9.]/g, "") })} />
        </span>
      </Field>
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
