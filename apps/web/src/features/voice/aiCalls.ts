/**
 * Pure shaping for the AI Calls page: the outcome filters and what each one matches, the tone an
 * outcome wears, and how a call's extracted details read. The list itself comes from the API
 * (GET /api/voice/calls), which already labels each call (callerLabel, durationLabel, outcomeLabel);
 * what's here is only the page's own choices, kept testable without the network.
 */
import type { Tone } from "@/components/ui/StatusPill";

/** One row of GET /api/voice/calls, as the API shapes it. */
export interface AiCallRow {
  id: string;
  when: string;
  callerLabel: string;
  durationLabel: string;
  outcome: string;
  outcomeLabel: string;
  summary: string | null;
  booked: boolean;
  hasTranscript: boolean;
  hasRecording: boolean;
  requestId: string | null;
  visitId: string | null;
}

/** The full ai_calls row, from GET /api/voice/calls/:id. `extracted` is what the agent pulled from the call. */
export interface AiCallDetail {
  id: string;
  provider: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  called_number: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  extracted: Record<string, unknown> | null;
  client_id: string | null;
  request_id: string | null;
  visit_id: string | null;
  request_number?: string | null;
  visit_starts_at?: string | null;
  created_at: string;
}

export type OutcomeFilterKey = "all" | "booked" | "messages" | "questions" | "transferred" | "other";

/**
 * The filter chips, in order. `param` is what goes in the list's ?outcome= (nothing for All);
 * `outcomes` is the set of raw outcomes the chip means, for anything shaped on this side.
 */
export const OUTCOME_FILTERS: Array<{ key: OutcomeFilterKey; label: string; param: string | null; outcomes: string[] | null }> = [
  { key: "all", label: "All", param: null, outcomes: null },
  { key: "booked", label: "Booked", param: "booked", outcomes: ["booked"] },
  { key: "messages", label: "Messages", param: "message", outcomes: ["message"] },
  { key: "questions", label: "Questions", param: "faq", outcomes: ["faq"] },
  { key: "transferred", label: "Transferred", param: "transferred", outcomes: ["transferred"] },
  { key: "other", label: "Other", param: "other", outcomes: ["other"] },
];

/** The outcomes the named chips claim; anything else (including "other" itself) is Other. */
const KNOWN_OUTCOMES = new Set(OUTCOME_FILTERS.filter((f) => f.key !== "other").flatMap((f) => f.outcomes ?? []));

/** Whether a raw outcome belongs under a filter chip (All matches everything). */
export function matchesOutcomeFilter(outcome: string | null | undefined, key: OutcomeFilterKey): boolean {
  if (key === "all") return true;
  const raw = (outcome ?? "").trim().toLowerCase();
  if (key === "other") return !KNOWN_OUTCOMES.has(raw);
  return OUTCOME_FILTERS.find((f) => f.key === key)?.outcomes?.includes(raw) ?? false;
}

/** The tone a call's outcome chip wears: a booking is the win, a transfer needs a person. */
export function outcomeTone(outcome: string | null | undefined): Tone {
  const raw = (outcome ?? "").trim().toLowerCase();
  if (raw === "booked") return "good";
  if (raw === "transferred" || raw === "transfer") return "warning";
  if (raw === "failed" || raw === "error" || raw === "no_answer") return "danger";
  if (matchesOutcomeFilter(raw, "messages")) return "info";
  return "muted";
}

/** "3m 20s" from seconds, for the detail view (the list's labels come from the API). */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** The extracted details worth naming first, in the order a person reads them. */
const EXTRACTED_ORDER: Array<[key: string, label: string]> = [
  ["name", "Name"],
  ["caller_name", "Name"],
  ["phone", "Phone"],
  ["caller_phone", "Phone"],
  ["service", "Service"],
  ["preferred_time", "Preferred time"],
  ["preferredTime", "Preferred time"],
  ["message", "Message"],
];

/**
 * A call's extracted details as label/value rows: the known ones first with plain labels, anything
 * else the agent pulled after them under its own name. Blank values leave no row.
 */
export function extractedRows(extracted: Record<string, unknown> | null | undefined): Array<{ label: string; value: string }> {
  if (!extracted) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const used = new Set<string>();
  const text = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  };
  for (const [key, label] of EXTRACTED_ORDER) {
    if (used.has(label)) continue;
    const value = text(extracted[key]);
    if (value) {
      rows.push({ label, value });
      used.add(label);
      used.add(key);
    }
  }
  for (const [key, value] of Object.entries(extracted)) {
    if (used.has(key)) continue;
    const shown = text(value);
    if (shown) rows.push({ label: key.replace(/_/g, " "), value: shown });
  }
  return rows;
}
