/**
 * On a draft quote that "Draft a quote" filled in (quotes.drafted, services/quoteDrafts.ts): who
 * drafted it, the lines whose quantity to check, and what the client answered on the request, for
 * the office to go by. Never on the client's copy. Drafted from the price list, it says that turning
 * on Claude drafts better.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";

export interface Drafted {
  by: "claude" | "price_list";
  request_number?: number | null;
  check?: string[];
  /** How many lines the draft came with: none means the price list had nothing for the request. */
  lines?: number | null;
  notes?: string | null;
  note?: string | null;
}

/** quotes.drafted as stored, or null for a quote nobody drafted. */
export function readDrafted(value: unknown): Drafted | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.by !== "claude" && d.by !== "price_list") return null;
  return {
    by: d.by,
    request_number: typeof d.request_number === "number" ? d.request_number : null,
    check: Array.isArray(d.check) ? d.check.filter((x): x is string => typeof x === "string") : [],
    lines: typeof d.lines === "number" ? d.lines : null,
    notes: typeof d.notes === "string" ? d.notes : null,
    note: typeof d.note === "string" ? d.note : null,
  };
}

/** What the callout says first: who drafted it, and from what. */
export function draftedWords(d: Drafted, checkNames: readonly string[]): string[] {
  const from = d.request_number ? `request #${d.request_number}` : "the request";
  // A draft that came with no lines isn't said to be drafted: its note says why, and to add them.
  const out = [d.lines === 0 ? `Started from ${from}.` : d.by === "claude" ? `Claude drafted this from ${from} and your price list. Look it over before you send it.` : `Drafted from ${from} and your price list. Look it over before you send it.`];
  if (checkNames.length) out.push(`Check the quantity on ${checkNames.join(", ")}: the request didn't say, so it's 1.`);
  if (d.note) out.push(d.note);
  return out;
}

export function DraftedCallout({ drafted, lines, requestId, admin }: { drafted: unknown; lines: ReadonlyArray<{ id: string; name: string }>; requestId: string | null; admin: boolean }) {
  const [showNotes, setShowNotes] = useState(false);
  const d = readDrafted(drafted);
  if (!d) return null;
  // Only lines still on the quote: one taken off needs no checking.
  const checkNames = (d.check ?? []).map((id) => lines.find((l) => l.id === id)?.name).filter((n): n is string => Boolean(n));
  const [first, ...rest] = draftedWords(d, checkNames);
  return (
    <div className="callout callout-info">
      <Icon name="sparkle" size={20} />
      <div className="grow stack-sm" style={{ gap: 4 }}>
        <span>{first}</span>
        {rest.map((line, i) => <span key={i} style={{ fontWeight: 400 }}>{line}</span>)}
        {d.by === "price_list" && (!d.note || d.lines === 0) && (
          <span className="small" style={{ fontWeight: 400 }}>
            {admin ? <>Turn on <Link to="/settings?tab=company">Draft quotes with Claude</Link> in Settings → Company to draft them better.</> : "An owner or admin can turn on Draft quotes with Claude in Settings → Company, which drafts them better."}
          </span>
        )}
        {d.notes && (
          <>
            <button type="button" className="link-btn small" style={{ justifySelf: "start" }} aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? "Hide what they answered" : "What they answered"}
            </button>
            {showNotes && <p className="pre-wrap small" style={{ margin: 0, fontWeight: 400 }}>{d.notes}</p>}
          </>
        )}
        {requestId && <Link className="small" style={{ fontWeight: 400 }} to={`/requests/${requestId}`}>Open the request</Link>}
      </div>
    </div>
  );
}
