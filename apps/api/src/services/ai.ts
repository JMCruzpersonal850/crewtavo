/**
 * Claude for in-app AI: rewriting messages, drafting quote text, answering from SOPs.
 * A company can bring its own Anthropic key (Apps page); otherwise the deployment's key is used.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { loadSecret } from "../integrations/tokens";
import { HttpError } from "../lib/http";
import { allow } from "../lib/limit";
import type { Db } from "../lib/supabase";

export interface CompleteOptions {
  system: string;
  prompt: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  apiKey?: string | null;
}

/** The key a company added under Apps → Claude, if any. */
export async function companyAnthropicKey(env: Env, admin: Db, companyId: string): Promise<string | null> {
  const secret = await loadSecret(env, admin, companyId, "anthropic").catch(() => null);
  return secret?.api_key ?? null;
}

/** What one person may ask of the AI in an hour, and everyone at one company between them. */
export const AI_ASKS_PER_PERSON = 60;
export const AI_ASKS_PER_COMPANY = 300;

/**
 * Counts one ask of the AI (a rewrite, a draft, a suggestion, an answer from the guides), for the
 * person and for their company, and refuses once either has had its hour's worth. Every ask is paid
 * for from the company's Claude key or the deployment's, so one sign-in can't run up either. One a
 * minute all hour is more than anyone drafting replies or captions asks for. An ask nobody made
 * (a quote drafted by itself as a request comes in: userId null) counts against the company alone.
 */
export async function countAiAsk(env: Env, companyId: string, userId: string | null): Promise<void> {
  if ((userId !== null && !(await allow(env, `ai:person:${userId}`, AI_ASKS_PER_PERSON, 3600))) || !(await allow(env, `ai:company:${companyId}`, AI_ASKS_PER_COMPANY, 3600))) {
    throw new HttpError(429, "That's a lot to ask the AI in an hour. Wait a while and try again.");
  }
}

/** The model in-app AI uses. */
export const aiModel = (env: Env) => env.AI_MODEL || "claude-opus-5-5";

/**
 * Whether a Claude key works, asked of Anthropic before a feature that spends it is turned on: null
 * when it does, else what to fix. Reading the model's details costs nothing.
 */
export async function checkAnthropicKey(env: Env, apiKey: string): Promise<string | null> {
  const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 });
  try {
    await client.models.retrieve(aiModel(env));
    return null;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return "Anthropic turned the Claude key down. Check that it was copied correctly on the Apps page, or make a new one in the Claude Console.";
    if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) return `The Claude key can't use ${aiModel(env)}. Check the key's workspace in the Claude Console.`;
    if (error instanceof Anthropic.RateLimitError) return "Anthropic is busy right now. Try again in a minute.";
    return "Crewtavo couldn't reach Anthropic to check the Claude key. Try again in a minute.";
  }
}

export interface ReadOptions {
  system: string;
  prompt: string;
  /** A photo (JPEG, PNG, GIF or WebP) or a PDF, as base64. */
  file: { data: string; mediaType: string };
  /** The JSON schema the answer must follow (structured outputs). */
  schema: Record<string, unknown>;
  apiKey?: string | null;
  maxTokens?: number;
  /** How long to wait before giving up, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Claude reads a picture or a PDF and answers as JSON in the given schema (structured outputs). The
 * answer comes back unparsed: whoever asked parses and checks it, since it's only ever data.
 */
export async function readDocument(env: Env, options: ReadOptions): Promise<string> {
  const apiKey = options.apiKey || env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(501, "AI isn't turned on yet. An admin can add a Claude key on the Apps page.");
  const client = new Anthropic({ apiKey, timeout: options.timeoutMs ?? 45_000, maxRetries: 0 });
  const file: Anthropic.Beta.BetaContentBlockParam =
    options.file.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: options.file.data } }
      : { type: "image", source: { type: "base64", media_type: options.file.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: options.file.data } };
  try {
    const response = await client.beta.messages.create({
      model: aiModel(env),
      max_tokens: options.maxTokens ?? 4000,
      system: options.system,
      messages: [{ role: "user", content: [file, { type: "text", text: options.prompt }] }],
      output_config: { effort: "low", format: { type: "json_schema", schema: options.schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") throw new HttpError(422, "The AI declined to read that file.");
    if (response.stop_reason === "max_tokens") throw new HttpError(502, "The AI's answer was cut off before it finished.");
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "The AI returned an empty answer. Try again.");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, "Reading it took too long.");
    if (error instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (error instanceof Anthropic.APIError) throw new HttpError(502, "The AI service had a problem. Try again.");
    throw error;
  }
}

export async function complete(env: Env, options: CompleteOptions): Promise<string> {
  const apiKey = options.apiKey || env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(501, "AI isn't turned on yet. An admin can add a Claude key on the Apps page.");
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.beta.messages.create({
      model: env.AI_MODEL || "claude-opus-5-5",
      max_tokens: options.maxTokens ?? 2000,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
      output_config: { effort: options.effort ?? "low" },
      // If a request is declined, the API retries it on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      throw new HttpError(422, "The AI declined that request. Try rephrasing it.");
    }
    // Out of room partway through: what there is of the answer stops mid-thought, and would read as whole.
    if (response.stop_reason === "max_tokens") {
      throw new HttpError(502, "The AI's answer was cut off before it finished. Try again, or ask for something shorter.");
    }
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "The AI returned an empty answer. Try again.");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (error instanceof Anthropic.APIError) throw new HttpError(502, "The AI service had a problem. Try again.");
    throw error;
  }
}
