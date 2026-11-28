/**
 * The small pure pieces of recording a voice walkthrough (VoiceWalkthrough.tsx): which recording
 * format this browser can make, what file ending a recording gets, and how long it has been
 * going, as a clock. Kept apart from the component so they can be tested without a microphone.
 */

/** The formats to try, best first: what Chrome/Android make, then Safari's, then Firefox's. */
const RECORDER_MIMES = ["audio/webm", "audio/mp4", "audio/ogg"];

/**
 * The MIME type to hand MediaRecorder: the first of RECORDER_MIMES the browser says it can
 * record, or "" to let the browser pick its own default when it supports none of them (or
 * doesn't say, as older browsers don't).
 */
export function pickRecorderMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of RECORDER_MIMES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // A browser that throws on a type it doesn't know hasn't ruled the next one out.
    }
  }
  return "";
}

/** The file ending for a recording of this type: "voice-….webm" on Android, "….m4a" on an iPhone. */
export function extensionForMime(mime: string): string {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("mpeg")) return "mp3";
  // Nothing known (the browser picked): an iPhone's default is MP4 audio, so its ending fits most.
  return "m4a";
}

/** Seconds as a recording clock: 0:00, 0:09, 1:23, 10:00. Part seconds round down. */
export function formatClock(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
