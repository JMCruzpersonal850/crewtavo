/**
 * Drawing on a stored photo, where photos are shown (a visit's Photos card, a job's or client's,
 * a quote's notes): the pen in the photo's corner opens the editor on what the photo shows (its
 * drawing, if it has one, so more can be added), and saves the drawing beside the original
 * (lib/photoMarkup.ts). "Original" opens the photo as taken.
 */
import { useState } from "react";
import { hasRole, isSub, type Session } from "@/lib/session";
import { photoPicture, removeMarkup, saveMarkup, shownPath, type MarkablePhoto } from "@/lib/photoMarkup";
import { toast } from "@/lib/toast";
import { PhotoEditor } from "./PhotoEditor";
import { Icon } from "./ui/Icon";

/** Who may draw on a stored photo: whoever may change it (attachments_update), the office or whoever added it. Never a sub. */
export const canDrawOn = (session: Pick<Session, "role" | "userId">, photo: { created_by?: string | null; author_id?: string | null }) =>
  !isSub(session) && (hasRole(session, "admin", "office") || (photo.created_by ?? photo.author_id) === session.userId);

export function DrawOnPhoto({ photo, label = "this photo", onSaved }: { photo: MarkablePhoto; label?: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const done = (words: string) => {
    toast.success(words);
    setOpen(false);
    onSaved();
  };
  return (
    <>
      <button type="button" className="thumb-draw" aria-label={`Draw on ${label}`} title="Draw on it" onClick={() => setOpen(true)}>
        <span className="thumb-draw-badge"><Icon name="pen" size={14} /></span>
      </button>
      {open && (
        <PhotoEditor
          picture={() => photoPicture(shownPath(photo))}
          onCancel={() => setOpen(false)}
          onSave={async (drawn) => {
            if (drawn) await saveMarkup(photo, drawn);
            done("Drawing saved");
          }}
          onRemoveDrawing={photo.marked_path ? async () => {
            await removeMarkup(photo);
            done("Drawing taken off");
          } : undefined}
        />
      )}
    </>
  );
}

/** On a photo with a drawing: a link to the photo as taken. */
export function OriginalLink({ url, label = "this photo" }: { url: string | null | undefined; label?: string }) {
  if (!url) return null;
  return <a className="thumb-original" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${label} as it was taken`}>Original</a>;
}
