/**
 * Turning a recording into words: OpenAI's transcription endpoint (Whisper), asked with a
 * company's own key (Apps → ChatGPT).
 *
 * Transcription is OpenAI-only — Claude has no audio endpoint, which is why this doesn't go
 * through services/ai.ts and its Claude-or-ChatGPT choosing: a voice report needs the
 * company's OpenAI key specifically, and services/voiceReports.ts says so when there isn't
 * one. Nothing here logs or returns the key: a failure is an OpenAiProblem, like every other
 * OpenAI call (integrations/openai.ts), so a bad key and an empty balance read the same here
 * as they do everywhere else.
 */
import { OPENAI_API, OpenAiProblem, problemOf } from "./openai";

/** A recording to transcribe: its bytes, what they are, and the name OpenAI files them under. */
export interface AudioFile {
  data: Uint8Array | ArrayBuffer;
  contentType: string;
  fileName: string;
}

/** How long a transcription may take: a walkthrough can run minutes, and Whisper is not instant. */
const TIMEOUT_MS = 120_000;

/**
 * The words in a recording, as OpenAI heard them. Throws OpenAiProblem on any failure —
 * the key turned down, the key out of credit, a timeout — for the caller to put in words.
 */
export async function transcribeAudio(apiKey: string, audio: AudioFile): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio.data as BlobPart], { type: audio.contentType }), audio.fileName);
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new OpenAiProblem((error as Error)?.name === "TimeoutError" ? "timeout" : "unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; type?: unknown; param?: unknown } | null } | null;
    throw problemOf(body && typeof body.error === "object" ? body.error : null, response.status, "key");
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) throw new OpenAiProblem("empty", response.status);
  return text;
}
