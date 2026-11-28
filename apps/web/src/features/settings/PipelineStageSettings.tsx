/**
 * Settings → Company → Sales board: the names a company gives the board's five stages, and the
 * stages it folds away (settings.pipeline_stages; core's pipelineStages reads what this saves).
 * Saved by itself, through merge_company_settings, like Job costing next to it.
 *
 * The stages themselves are fixed — each holds the same request and quote statuses it always
 * has, and automations, the activity feed and the database's triggers key on those statuses —
 * so this screen renames and folds, and never invents a stage or moves a status. A folded
 * stage's cards ride in the stage before it on the board, under their own status.
 */
import { PIPELINE_STAGE_KEYS, PIPELINE_STAGE_LABELS, PIPELINE_STAGE_LABEL_MAX, pipelineStages, pipelineStagesSetting, type PipelineStageKey } from "@crewtavo/core/pipeline";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import p from "./Prefs.module.css";
import { SwitchRow } from "./SettingsKit";

export function PipelineStageSettings({ settings }: { settings: Record<string, unknown> }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const saved = pipelineStages(settings);
  const [names, setNames] = useState<Record<PipelineStageKey, string>>(() => Object.fromEntries(saved.map((s) => [s.key, s.label])) as Record<PipelineStageKey, string>);
  const [shown, setShown] = useState<Record<PipelineStageKey, boolean>>(() => Object.fromEntries(saved.map((s) => [s.key, !s.hidden])) as Record<PipelineStageKey, boolean>);
  const shownCount = PIPELINE_STAGE_KEYS.filter((k) => shown[k]).length;

  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // Cleaned by the same reader the board uses, so what saves is exactly what the board draws.
      const cleaned = pipelineStagesSetting({
        pipeline_stages: {
          labels: Object.fromEntries(PIPELINE_STAGE_KEYS.map((k) => [k, names[k]])),
          hidden: PIPELINE_STAGE_KEYS.filter((k) => !shown[k]),
        },
      });
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: { pipeline_stages: cleaned } as never }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const done = useJustDone(save);
  const changed = saved.some((s) => names[s.key] !== s.label || shown[s.key] === s.hidden);

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <Section level={3} title="Sales board">
        <div className="set-rows">
          <p className="set-hint" style={{ margin: 0 }}>
            The board&apos;s stages in your words. Rename any of them; fold one away and its cards ride in the stage
            before it, still under their own status. The stages themselves don&apos;t change — what each one holds
            is what your automations and reports already go by.
          </p>
          {PIPELINE_STAGE_KEYS.map((key) => (
            <SwitchRow
              key={key}
              label={`Show “${names[key].trim() || PIPELINE_STAGE_LABELS[key]}” on the board`}
              hint={key === "new" ? "Requests land here first." : key === "assess" ? "Visits booked and done." : key === "draft" ? "Quotes being written." : key === "sent" ? "Quotes out, waiting on the client." : "Quotes the client approved."}
              checked={shown[key]}
              disabled={shown[key] && shownCount <= 1}
              onChange={(next) => setShown({ ...shown, [key]: next })}
            >
              <Field label="Stage name" hint={`Blank keeps “${PIPELINE_STAGE_LABELS[key]}”.`} className="set-narrow">
                <input
                  className="input"
                  value={names[key] === PIPELINE_STAGE_LABELS[key] ? "" : names[key]}
                  placeholder={PIPELINE_STAGE_LABELS[key]}
                  maxLength={PIPELINE_STAGE_LABEL_MAX}
                  onChange={(e) => setNames({ ...names, [key]: e.target.value })}
                />
              </Field>
            </SwitchRow>
          ))}
        </div>
        <FormError error={save.error} />
        <div className={p.groupSave}>
          <Button type="submit" size="sm" loading={save.isPending} done={done} disabled={!changed}>Save</Button>
          {changed && !save.isPending && <span className="set-save-note">Not saved yet</span>}
          <FormChecks />
        </div>
      </Section>
    </form>
  );
}
