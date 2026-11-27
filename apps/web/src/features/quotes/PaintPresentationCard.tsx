/**
 * A painting proposal's own words for its client page (quotes.paint_presentation), edited
 * beside the message: the Overall Scope of Work paragraph, the Job Notes, and the What's
 * Included checklist — the pieces Lead Control's proposals carry beyond their lines. The
 * message above stays what it is (the note over the lines); anything left blank here falls
 * back on the client's page to what the proposal already carries — the scope to the lines'
 * descriptions, the notes to the message, the checklist to the picked package's highlights.
 * Painting only: QuotePage mounts it behind isPaintingTrade.
 */
import { paintPresentationFrom, type PaintPresentation } from "@crewtavo/core/painting";
import { useEffect, useState } from "react";
import { Section } from "@/components/ui/Section";
import styles from "./QuotePage.module.css";

const same = (a: PaintPresentation, b: PaintPresentation) =>
  a.scope === b.scope && a.notes === b.notes && a.highlights.length === b.highlights.length && a.highlights.every((h, i) => h === b.highlights[i]);

export function PaintPresentationCard({ value, editable, onEdit, onUnchanged, onSave }: {
  value: unknown;
  editable: boolean;
  onEdit: () => void;
  onUnchanged: () => void;
  onSave: (presentation: PaintPresentation) => void;
}) {
  const current = paintPresentationFrom(value);
  const [scope, setScope] = useState(current.scope ?? "");
  const [notes, setNotes] = useState(current.notes ?? "");
  const [checks, setChecks] = useState(current.highlights.join("\n"));
  useEffect(() => {
    const parsed = paintPresentationFrom(value);
    setScope(parsed.scope ?? "");
    setNotes(parsed.notes ?? "");
    setChecks(parsed.highlights.join("\n"));
  }, [value]);

  const commit = () => {
    const next: PaintPresentation = {
      scope: scope.trim() || null,
      notes: notes.trim() || null,
      highlights: checks.split("\n").map((h) => h.trim()).filter(Boolean),
    };
    if (!same(next, paintPresentationFrom(value))) onSave(next);
    else onUnchanged();
  };

  const title = <>Proposal page <span className={styles.titleNote}>the scope, notes and checklist the client reads</span></>;
  if (!editable) {
    if (!current.scope && !current.notes && current.highlights.length === 0) return null;
    return (
      <Section title={title}>
        {current.scope && <p className="pre-wrap">{current.scope}</p>}
        {current.highlights.length > 0 && (
          <ul>
            {current.highlights.map((h) => <li key={h}>{h}</li>)}
          </ul>
        )}
        {current.notes && <p className="pre-wrap">{current.notes}</p>}
      </Section>
    );
  }
  return (
    <Section title={title}>
      <div className={styles.messageField}>
        <label className={styles.fieldLabel} htmlFor="paint-scope">Overall scope of work</label>
        <textarea
          id="paint-scope"
          className="textarea"
          aria-label="Overall scope of work"
          value={scope}
          maxLength={4000}
          rows={3}
          onChange={(e) => { setScope(e.target.value); onEdit(); }}
          onBlur={commit}
          placeholder="Repaint the painted brick exterior of the home at 504 Silverthorn Road…"
        />
        <label className={styles.fieldLabel} htmlFor="paint-included">What's included — one per line</label>
        <textarea
          id="paint-included"
          className="textarea"
          aria-label="What's included, one per line"
          value={checks}
          maxLength={4000}
          rows={4}
          onChange={(e) => { setChecks(e.target.value); onEdit(); }}
          onBlur={commit}
          placeholder={"Cash offer — $3,500 total\n1 coat Sherwin-Williams Emerald Rain Refresh\nCover and protect back doors and deck\nNo warranty included"}
        />
        <label className={styles.fieldLabel} htmlFor="paint-notes">Job notes</label>
        <textarea
          id="paint-notes"
          className="textarea"
          aria-label="Job notes"
          value={notes}
          maxLength={4000}
          rows={2}
          onChange={(e) => { setNotes(e.target.value); onEdit(); }}
          onBlur={commit}
          placeholder="Anything the client should know that isn't scope…"
        />
        <p className={styles.quiet}>Anything left blank falls back on the client's page: the scope to the lines' own descriptions, the notes to the message above, the checklist to the package the client picks.</p>
      </div>
    </Section>
  );
}
