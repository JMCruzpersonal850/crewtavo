/**
 * The sales board's stages, as the company names them (settings.pipeline_stages; Settings →
 * Company → Sales board).
 *
 * The board's five stages are fixed in what they hold: each one is a set of request and quote
 * statuses, and statuses are what the rest of the app keys on — automation rules and their
 * conditions, the activity feed and its notices, the database's own triggers. So a company can't
 * invent a stage or move a status to another stage; what it can do is rename a stage in its own
 * words ("Leads", "Site visits", "Building proposal", "Proposal sent", "Won") and fold a stage
 * away. A folded stage's cards don't vanish: they ride in the stage before it on the board, under
 * their own status. Nothing here renames or reassigns a status.
 */

export const PIPELINE_STAGE_KEYS = ["new", "assess", "draft", "sent", "won"] as const;
export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];

/** The stages' names before a company renames any. */
export const PIPELINE_STAGE_LABELS: Record<PipelineStageKey, string> = {
  new: "New requests",
  assess: "Assessments",
  draft: "Drafting quote",
  sent: "Awaiting response",
  won: "Approved",
};

/** The longest name a stage can be given. */
export const PIPELINE_STAGE_LABEL_MAX = 40;

export interface PipelineStage {
  key: PipelineStageKey;
  /** The company's name for the stage, or its default. */
  label: string;
  /** Folded away: its cards ride in the stage before it. */
  hidden: boolean;
}

const isKey = (v: unknown): v is PipelineStageKey => typeof v === "string" && (PIPELINE_STAGE_KEYS as readonly string[]).includes(v);

/** A stage's name as typed: trimmed, single-spaced, capped; nothing usable in it reads as no name. */
export function pipelineStageLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const label = v.trim().replace(/\s+/g, " ").slice(0, PIPELINE_STAGE_LABEL_MAX).trim();
  return label || null;
}

/**
 * What a company has saved for its board (settings.pipeline_stages), cleaned: names it gave the
 * stages (its defaults left out) and the stages it folded away. The shape Settings saves and
 * pipelineStages reads, so the two can't drift apart.
 */
export function pipelineStagesSetting(settings: unknown): { labels: Partial<Record<PipelineStageKey, string>>; hidden: PipelineStageKey[] } {
  const saved = (settings as { pipeline_stages?: unknown } | null | undefined)?.pipeline_stages;
  const raw = saved && typeof saved === "object" ? (saved as { labels?: unknown; hidden?: unknown }) : {};
  const rawLabels = raw.labels && typeof raw.labels === "object" ? (raw.labels as Record<string, unknown>) : {};
  const labels: Partial<Record<PipelineStageKey, string>> = {};
  for (const key of PIPELINE_STAGE_KEYS) {
    const label = pipelineStageLabel(rawLabels[key]);
    if (label && label !== PIPELINE_STAGE_LABELS[key]) labels[key] = label;
  }
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter(isKey))] : [];
  return { labels, hidden };
}

/** The board's stages as the company has them: its names over the defaults, its folded stages marked. */
export function pipelineStages(settings: unknown): PipelineStage[] {
  const { labels, hidden } = pipelineStagesSetting(settings);
  const stages = PIPELINE_STAGE_KEYS.map((key) => ({ key, label: labels[key] ?? PIPELINE_STAGE_LABELS[key], hidden: hidden.includes(key) }));
  // A board with every stage folded away is no board at all: all of them show.
  return stages.every((s) => s.hidden) ? stages.map((s) => ({ ...s, hidden: false })) : stages;
}

export interface PipelineLane {
  /** The shown stage the lane is named for. */
  key: PipelineStageKey;
  label: string;
  /** The lane's stages in board order: the shown one, then any folded stages riding in it. */
  stages: PipelineStageKey[];
}

/**
 * The lanes the board draws: each shown stage is a lane, and a folded stage rides in the shown
 * stage before it — or, for stages folded ahead of the first shown one, in that first lane.
 */
export function pipelineLanes(settings: unknown): PipelineLane[] {
  const lanes: PipelineLane[] = [];
  let waiting: PipelineStageKey[] = [];
  for (const stage of pipelineStages(settings)) {
    if (stage.hidden) {
      if (lanes.length) lanes[lanes.length - 1]!.stages.push(stage.key);
      else waiting.push(stage.key);
    } else {
      lanes.push({ key: stage.key, label: stage.label, stages: [...waiting, stage.key] });
      waiting = [];
    }
  }
  return lanes;
}
