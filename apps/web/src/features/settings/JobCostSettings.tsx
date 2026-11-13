/**
 * Settings → Company → Job costing: "Tell me when a job's profit falls below X%"
 * (settings.profit_alert_percent, off unless set). The server checks every hour
 * (apps/api/src/services/profitAlerts.ts) and the people who see job costs are told as a job goes
 * below. Saved by itself, through merge_company_settings, which only owners and admins get through.
 */
import { profitAlertPercent } from "@crewtavo/core/reports";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export function JobCostSettings({ settings }: { settings: Record<string, unknown> }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const saved = profitAlertPercent(settings);
  const [on, setOn] = useState(saved !== null);
  const [percent, setPercent] = useState(saved !== null ? String(saved) : "20");
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const value = on ? Number(percent) : null;
      if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 99)) throw new Error("Enter a whole percent from 1 to 99.");
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: { profit_alert_percent: value } as never }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const done = useJustDone(save);
  const changed = on !== (saved !== null) || (on && Number(percent) !== saved);

  return (
    <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <strong>Job costing</strong>
      <label className="switch-row" style={{ fontWeight: 400 }}>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Tell me when a job&apos;s profit falls below a margin
      </label>
      {on && (
        <Field label="Margin" hint="A whole percent. Job costing on the job's page shows a warning while it's below.">
          <span className="input-group" style={{ maxWidth: 140 }}>
            <input className="input" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} required style={{ paddingLeft: 12, paddingRight: 32 }} />
            <span className="addon addon-right">%</span>
          </span>
        </Field>
      )}
      <span className="muted small">
        Checked every hour, for one-off jobs with a price and some time, pay, expenses or materials on them, over the whole job, as job costing counts it. Repeating jobs aren&apos;t checked, since their price is for a visit or a month.
        The people who see job costs get one notification as a job goes below, and another only if it comes back up and falls again.
        After you change the margin, the jobs already below it are listed under Below your margin on the Jobs page instead of one notification each.
      </span>
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <FormChecks />
        <Button type="submit" variant="primary" loading={save.isPending} done={done} disabled={!changed}>Save</Button>
      </div>
    </form>
  );
}
