/**
 * Picking rows on a list page to act on them at once: a box on each row, one in the heading for
 * every row on the page, and a bar above the list with how many are picked and what can be done.
 * The logic, and writing them in chunks, is lib/bulk.ts.
 */
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inChunks, mergeResults, pageState, pickedOnPage, reportBulk, toggleAll, toggleOne, type BulkResult, type BulkWords } from "@/lib/bulk";
import { queryClient } from "@/lib/queryClient";
import type { ToastTone } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { Button, cx } from "./Button";
import { t } from "@/lib/i18n";

/**
 * What's picked among `pageIds`. A new `reset` (another filter, a search) starts with nothing picked.
 * A phone picks in a mode of its own, as its mail app does: the boxes show once Select is pressed
 * (`start`) or something is picked (`active`), and Cancel, Escape or clearing the picks ends it. A
 * desktop's boxes show under the pointer or the keyboard, and on every row once something is picked.
 */
export function useSelection(pageIds: readonly string[], reset: string) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [picking, setPicking] = useState(false);
  const [shown, setShown] = useState(reset);
  if (shown !== reset) {
    setShown(reset);
    setPicked(new Set());
    setPicking(false);
  }
  const ids = pickedOnPage(picked, pageIds);
  return {
    /** Picked and on the page, in its order. */
    ids,
    state: pageState(picked, pageIds),
    /** Picking (a phone's Select mode), or something is picked. */
    active: picking || ids.length > 0,
    has: (id: string) => picked.has(id),
    toggle: (id: string) => setPicked((p) => toggleOne(p, id)),
    toggleAll: () => setPicked((p) => toggleAll(p, pageIds)),
    /** A phone's Select: the boxes show. */
    start: () => setPicking(true),
    /** Nothing picked, and a phone's boxes put away (Cancel, Escape, or done with an action on them). */
    clear: () => {
      setPicked(new Set());
      setPicking(false);
    },
  };
}
export type Selection = ReturnType<typeof useSelection>;

function SelectAllBox({ selection, label }: { selection: Selection; label: string }) {
  const box = useRef<HTMLInputElement>(null);
  // A dash when only some are picked: there's no attribute for it, only the property.
  useEffect(() => {
    if (box.current) box.current.indeterminate = selection.state === "some";
  });
  return <input ref={box} type="checkbox" aria-label={label} checked={selection.state === "all"} onChange={selection.toggleAll} />;
}

/** The heading cell: picks every row on this page (a dash when only some are). */
export function SelectAllCell({ selection, label }: { selection: Selection; label: string }) {
  return <th className="select-cell"><label><SelectAllBox selection={selection} label={label} /></label></th>;
}

/** A row's box. A click on it, or near it, picks the row rather than opening it. */
export function SelectCell({ selection, id, label }: { selection: Selection; id: string; label: string }) {
  return (
    <td className="select-cell" onClick={(e) => e.stopPropagation()}>
      <label><input type="checkbox" aria-label={label} checked={selection.has(id)} onChange={() => selection.toggle(id)} /></label>
    </td>
  );
}

/**
 * Above the list, in view as it scrolls: how many are picked, the actions, and Clear. On a phone,
 * where the table's headings are hidden, it's where Select all is too, so it shows before any are.
 * Over an InboxList (which has no heading row for a Select all box) pass `always`, so a desktop
 * has it too: out of sight until something is picked or the keyboard reaches its box (components.css).
 *
 * On a phone (components.css) the rows keep their room until someone means to pick: the bar is just
 * a quiet Select on the right, which turns the boxes on and becomes Cancel (one button, so the focus
 * stays on it). Picking, it's one line: the count, the actions (scrolling sideways if they must) and
 * Cancel. Escape cancels too.
 */
export function SelectionBar({ selection, noun, children, always }: { selection: Selection; noun: string; children: ReactNode; always?: boolean }) {
  const count = selection.ids.length;
  const { active, clear } = selection;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog or a menu open over the list takes its own Escape.
      if (document.querySelector("dialog[open]") || popoverOpen()) return;
      clear();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, clear]);
  return (
    <>
      <span className="sr-only" role="status">{count ? t("{count} selected", { count }) : ""}</span>
      <div className={cx("select-bar", !count && !always && "mobile-only")} data-picked={count || undefined} data-mode={active ? "on" : "off"}>
        <label className="select-bar-all">
          <SelectAllBox selection={selection} label={t("Select all {noun} on this page", { noun })} />
          <span aria-hidden="true">{count ? t("{count} selected", { count }) : t("Select all")}</span>
        </label>
        {count > 0 && (
          <>
            <div className="select-bar-actions">{children}</div>
            <Button size="sm" variant="ghost" className="select-bar-clear" onClick={selection.clear}>{t("Clear")}</Button>
          </>
        )}
        <button type="button" className="select-bar-mode" onClick={active ? selection.clear : selection.start}>{active ? t("Cancel") : t("Select")}</button>
      </div>
    </>
  );
}

/** Whether a menu or a panel (a popover) is open. */
function popoverOpen(): boolean {
  try {
    return Boolean(document.querySelector(".menu:popover-open, .panel:popover-open"));
  } catch {
    return false;
  }
}

/**
 * Archiving picked rows, once the count is confirmed: they leave the list at once with Undo
 * (lib/undo.ts) and are archived when the toast goes, `write` a chunk at a time. Then any that
 * couldn't be (and `skipped`, left out before) are said with why, and the list is fetched again.
 */
export function archiveWithUndo<T>(o: {
  key: QueryKey;
  ids: string[];
  title: string;
  tone?: ToastTone;
  /** The list without the archived rows, or with them shown as archived where its filter keeps them. */
  hide: (data: T, ids: ReadonlySet<string>) => T;
  write: (chunk: string[]) => Promise<readonly string[]>;
  words: BulkWords;
  skipped?: BulkResult;
  refresh: () => Promise<unknown>;
}) {
  const before = queryClient.getQueryData<T>(o.key);
  const picked = new Set(o.ids);
  undoable({
    title: o.title,
    tone: o.tone,
    hide: () => {
      void queryClient.cancelQueries({ queryKey: o.key });
      queryClient.setQueryData<T>(o.key, (data) => (data === undefined ? data : o.hide(data, picked)));
    },
    restore: () => queryClient.setQueryData<T>(o.key, before),
    commit: async () => {
      const result = await inChunks(o.ids, o.write);
      reportBulk(o.skipped ? mergeResults(result, o.skipped) : result, o.words, { said: true, tone: o.tone });
      await o.refresh();
    },
  });
}
