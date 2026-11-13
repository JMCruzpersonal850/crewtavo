/**
 * Photos drawn on (the photo editor, components/PhotoEditor.tsx), as they're stored: the photo as
 * taken stays where it is, and the drawing is a copy beside it in the same folder (so exactly the
 * people who can see the photo can see it), named on the photo's row (attachments.marked_path;
 * supabase/migrations/20261113001010_marked_up_photos.sql). Screens show the drawing, with a way to
 * see the original. Removing the photo removes both; the database sees to that.
 *
 * A photo drawn on as it's added to a visit goes through the phone's queue with its drawing
 * (lib/offlinePhotos.ts), so it works with no signal. Drawing on one that's already up needs signal.
 */
import { supabase, unwrap } from "./api";
import { signedUrls, uploadOnce } from "./files";

/** A photo's row, as far as its drawing goes. */
export interface MarkablePhoto {
  id: string;
  path: string;
  marked_path?: string | null;
}

/** Where a photo's drawing is stored: in the photo's own folder, under a name of its own. */
export function markedPathFor(path: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${crypto.randomUUID()}.jpg`;
}

/** The file a photo shows: its drawing when it has one, else the photo as taken. */
export const shownPath = (photo: Pick<MarkablePhoto, "path" | "marked_path">) => photo.marked_path || photo.path;

/** Every file these photos show or can show (each one's original and drawing), for one round of signed links. */
export const photoPaths = (photos: ReadonlyArray<Pick<MarkablePhoto, "path" | "marked_path">>) => [...new Set(photos.flatMap((p) => (p.marked_path ? [p.path, p.marked_path] : [p.path])))];

/** Links to a set of photos: the one shown (the drawing, if any) and the original. Unavailable files are null. */
export async function photoLinks<P extends Pick<MarkablePhoto, "path" | "marked_path">>(photos: readonly P[]): Promise<Array<P & { url: string | null; originalUrl: string | null }>> {
  const urls = await signedUrls(photoPaths(photos)).catch(() => ({}) as Record<string, string>);
  return photos.map((p) => ({ ...p, url: urls[shownPath(p)] ?? urls[p.path] ?? null, originalUrl: urls[p.path] ?? null }));
}

/** A stored photo's picture, to draw on: read as the person, under the files bucket's rules. */
export async function photoPicture(path: string): Promise<Blob> {
  const { data, error } = await supabase().storage.from("files").download(path);
  if (error || !data) throw new Error("This photo couldn't be opened. Check your signal and try again.");
  return data;
}

/**
 * Saves a drawing on a photo that's already up: the picture beside it, then the row pointing at
 * it (the old drawing, if any, goes to the Trash). A picture the row then can't take (someone else's
 * photo) is taken back off.
 */
export async function saveMarkup(photo: Pick<MarkablePhoto, "id" | "path">, picture: Blob): Promise<string> {
  const path = markedPathFor(photo.path);
  await uploadOnce(path, picture);
  try {
    const rows = unwrap(await supabase().from("attachments").update({ marked_path: path }).eq("id", photo.id).select("id"));
    if (!rows.length) throw new Error("You can draw on photos you added. Ask the office to draw on this one.");
  } catch (error) {
    await supabase().storage.from("files").remove([path]).catch(() => undefined);
    throw error;
  }
  return path;
}

/** Takes the drawing off a photo: the original shows again, and the drawing goes to the Trash. */
export async function removeMarkup(photo: Pick<MarkablePhoto, "id">): Promise<void> {
  const rows = unwrap(await supabase().from("attachments").update({ marked_path: null }).eq("id", photo.id).select("id"));
  if (!rows.length) throw new Error("You can change photos you added. Ask the office to change this one.");
}
