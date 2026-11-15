/**
 * Crewtavo's own AI: rewriting messages, drafting quote text, answering from SOPs, reading
 * receipts. Every feature asks through `complete` or `readDocument`, saying who is asking, and
 * which service answers is decided here, in this order:
 *
 *   1. the company's own key: its Claude key (Apps → Claude) or its OpenAI key (Apps → ChatGPT).
 *      With both, the one the company chose (settings.ai.service), and Claude until it chooses.
 *   2. the deployment's Claude key (ANTHROPIC_API_KEY), for a company with neither.
 *
 * A company that only ever added a Claude key, or none, gets exactly what it had before OpenAI
 * could be used at all.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { askWithKey, checkOpenAiKey, listKeyModels, OpenAiProblem, pickModel, type OpenAiAsk, type OpenAiModel } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { asJson, HttpError } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient, type Db } from "../lib/supabase";

/**
 * Who an ask is for: the company, and the person who asked for it themselves while signed in.
 * `userId` is null for anything Crewtavo does by itself (a quote drafted as a request comes in) or
 * for somebody else.
 */
export interface Asker {
  companyId: string;
  userId: string | null;
}

/** The signed-in person a request is from, asking for themselves. */
export const askerOf = (c: { var: { companyId: string; userId: string } }): Asker => ({ companyId: c.var.companyId, userId: c.var.userId });

export interface CompleteOptions {
  asker: Asker;
  system: string;
  prompt: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

/** The key a company added under Apps → Claude, if any. */
export async function companyAnthropicKey(env: Env, admin: Db, companyId: string): Promise<string | null> {
  const secret = await loadSecret(env, admin, companyId, "anthropic").catch(() => null);
  return secret?.api_key ?? null;
}

/** What Apps → ChatGPT keeps beside the company's OpenAI key (integrations.settings; nothing secret). */
export interface OpenAiSettings {
  /** The model the admin picked, among `models`. */
  model?: string | null;
  /** The models OpenAI listed for the key when it was last asked. */
  models?: OpenAiModel[];
  /** Models that turned reasoning effort down, so it isn't sent to them again. */
  no_effort?: string[];
}

/** Which of its own keys a company with both chose (settings.ai.service), or null while it hasn't. */
export const aiChoice = (settings: unknown): "claude" | "chatgpt" | null => {
  const service = (settings as { ai?: { service?: unknown } } | null)?.ai?.service;
  return service === "claude" || service === "chatgpt" ? service : null;
};

export type CompanyAi =
  /** `own`: the company's key, not the deployment's. */
  | { service: "claude"; apiKey: string; own: boolean }
  | { service: "chatgpt"; apiKey: string; settings: OpenAiSettings };

/** The service that answers for a company: its own key (the one it chose, with both), else the deployment's Claude key, else none. */
export async function companyAi(env: Env, admin: Db, companyId: string): Promise<CompanyAi | null> {
  const [claude, openai] = await Promise.all([companyAnthropicKey(env, admin, companyId), loadSecret(env, admin, companyId, "chatgpt").then((s) => s?.api_key ?? null, () => null)]);
  let service: "claude" | "chatgpt" = openai && !claude ? "chatgpt" : "claude";
  if (claude && openai) {
    const { data } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
    service = aiChoice(data?.settings) ?? "claude";
  }
  if (service === "chatgpt" && openai) {
    const { data } = await admin.from("integrations").select("settings").eq("company_id", companyId).eq("provider", "chatgpt").maybeSingle();
    return { service, apiKey: openai, settings: (data?.settings ?? {}) as OpenAiSettings };
  }
  const key = claude ?? env.ANTHROPIC_API_KEY ?? null;
  return key ? { service: "claude", apiKey: key, own: Boolean(claude) } : null;
}

/** Whether an ask from this person, or from the company alone (`userId` null), has a service to answer it. */
export async function aiAvailable(env: Env, admin: Db, asker: Asker): Promise<boolean> {
  return Boolean(await companyAi(env, admin, asker.companyId));
}

/** What one person may ask of the AI in an hour, and everyone at one company between them. */
export const AI_ASKS_PER_PERSON = 60;
export const AI_ASKS_PER_COMPANY = 300;

/**
 * Counts one ask of the AI (a rewrite, a draft, a suggestion, an answer from the guides), for the
 * person and for their company, and refuses once either has had its hour's worth, whichever service
 * answers and whoever pays for it, so one sign-in can't run up anyone's bill. One a minute all hour
 * is more than anyone drafting replies or captions asks for. An ask nobody made (a quote drafted by
 * itself as a request comes in: userId null) counts against the company alone.
 */
export async function countAiAsk(env: Env, companyId: string, userId: string | null): Promise<void> {
  if ((userId !== null && !(await allow(env, `ai:person:${userId}`, AI_ASKS_PER_PERSON, 3600))) || !(await allow(env, `ai:company:${companyId}`, AI_ASKS_PER_COMPANY, 3600))) {
    throw new HttpError(429, "That's a lot to ask the AI in an hour. Wait a while and try again.");
  }
}

/** How many receipts and supplier invoices one person may have read in an hour, and everyone at one company between them. */
export const RECEIPT_READS_PER_PERSON = 60;
export const RECEIPT_READS_PER_COMPANY = 300;

/**
 * Counts one receipt or supplier invoice read, for the person and for their company, and says
 * whether it's within the hour's allowance. Reading has an allowance of its own, apart from the
 * asks countAiAsk counts: a bookkeeper catching up on a stack of receipts would otherwise use up
 * the hour's asks for everyone's replies, captions and drafts. Past it nothing is refused for good:
 * whoever asked decides what waits (routes/receipts.ts).
 */
export async function allowReceiptRead(env: Env, companyId: string, userId: string): Promise<boolean> {
  return (await allow(env, `receipts:person:${userId}`, RECEIPT_READS_PER_PERSON, 3600)) && (await allow(env, `receipts:company:${companyId}`, RECEIPT_READS_PER_COMPANY, 3600));
}

/** The Claude model in-app AI uses. */
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

/** With no key of the company's and none on the server. */
export const NO_AI = "AI isn't turned on yet. An admin can add a Claude or OpenAI key on the Apps page.";

/**
 * Whether the service that answers for the company by itself works, asked of that service before a
 * feature that spends it is turned on (reading receipts): null when it does, else what to fix, in
 * the words of the app the key is from.
 */
export async function checkCompanyAi(env: Env, admin: Db, companyId: string): Promise<string | null> {
  const ai = await companyAi(env, admin, companyId);
  if (!ai) return "Add a Claude or OpenAI key on the Apps page first, then turn this on.";
  if (ai.service === "claude") return checkAnthropicKey(env, ai.apiKey);
  const checked = await checkOpenAiKey(ai.apiKey);
  return "problem" in checked ? `${checked.problem} The key is under Apps → ChatGPT.` : null;
}

export interface ReadOptions {
  asker: Asker;
  system: string;
  prompt: string;
  /** A photo (JPEG, PNG, GIF or WebP) or a PDF, as base64. */
  file: { data: string; mediaType: string };
  /** The JSON schema the answer must follow (structured outputs). */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** How long to wait before giving up, in milliseconds. */
  timeoutMs?: number;
}

/** One ask, whichever service takes it. */
interface Ask {
  system: string;
  prompt: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  timeoutMs: number;
  file?: ReadOptions["file"];
  schema?: Record<string, unknown>;
}

/**
 * The AI reads a picture or a PDF and answers as JSON in the given schema (structured outputs). The
 * answer comes back unparsed: whoever asked parses and checks it, since it's only ever data.
 */
export async function readDocument(env: Env, options: ReadOptions): Promise<string> {
  return answer(env, options.asker, { system: options.system, prompt: options.prompt, effort: "low", maxTokens: options.maxTokens ?? 4000, timeoutMs: options.timeoutMs ?? 45_000, file: options.file, schema: options.schema });
}

export async function complete(env: Env, options: CompleteOptions): Promise<string> {
  return answer(env, options.asker, { system: options.system, prompt: options.prompt, effort: options.effort ?? "low", maxTokens: options.maxTokens ?? 2000, timeoutMs: 60_000 });
}

async function answer(env: Env, asker: Asker, ask: Ask): Promise<string> {
  const admin = adminClient(env);
  const ai = await companyAi(env, admin, asker.companyId);
  if (!ai) throw new HttpError(501, NO_AI);
  return ai.service === "chatgpt" ? askOpenAiKey(env, admin, asker.companyId, ai, ask) : ask.file ? readWithClaude(env, ai.apiKey, ask) : completeWithClaude(env, ai.apiKey, ask);
}

// ---------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------

async function readWithClaude(env: Env, apiKey: string, ask: Ask): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: ask.timeoutMs, maxRetries: 0 });
  const file: Anthropic.Beta.BetaContentBlockParam =
    ask.file!.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: ask.file!.data } }
      : { type: "image", source: { type: "base64", media_type: ask.file!.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: ask.file!.data } };
  try {
    const response = await client.beta.messages.create({
      model: aiModel(env),
      max_tokens: ask.maxTokens,
      system: ask.system,
      messages: [{ role: "user", content: [file, { type: "text", text: ask.prompt }] }],
      output_config: { effort: "low", format: { type: "json_schema", schema: ask.schema! } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") throw new HttpError(422, DECLINED_FILE);
    if (response.stop_reason === "max_tokens") throw new HttpError(502, "The AI's answer was cut off before it finished.");
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, EMPTY);
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, "Reading it took too long.");
    if (error instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, BUSY);
    if (error instanceof Anthropic.APIError) throw new HttpError(502, HAD_A_PROBLEM);
    throw error;
  }
}

async function completeWithClaude(env: Env, apiKey: string, ask: Ask): Promise<string> {
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.beta.messages.create({
      model: env.AI_MODEL || "claude-opus-5-5",
      max_tokens: ask.maxTokens,
      system: ask.system,
      messages: [{ role: "user", content: ask.prompt }],
      output_config: { effort: ask.effort },
      // If a request is declined, the API retries it on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      throw new HttpError(422, DECLINED);
    }
    // Out of room partway through: what there is of the answer stops mid-thought, and would read as whole.
    if (response.stop_reason === "max_tokens") {
      throw new HttpError(502, CUT_OFF);
    }
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, EMPTY);
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, BUSY);
    if (error instanceof Anthropic.APIError) throw new HttpError(502, HAD_A_PROBLEM);
    throw error;
  }
}

// What people are told, the same whichever service answered.
const DECLINED = "The AI declined that request. Try rephrasing it.";
const DECLINED_FILE = "The AI declined to read that file.";
const CUT_OFF = "The AI's answer was cut off before it finished. Try again, or ask for something shorter.";
const EMPTY = "The AI returned an empty answer. Try again.";
const BUSY = "The AI is busy right now. Try again in a minute.";
const HAD_A_PROBLEM = "The AI service had a problem. Try again.";

// ---------------------------------------------------------------------------------------------
// OpenAI, with the company's key
// ---------------------------------------------------------------------------------------------

/**
 * What an answer that isn't whole says to whoever asked: the same words as with Claude. Null for
 * the problems that are about the key or the plan rather than the answer.
 */
export function answerProblem(problem: OpenAiProblem, ask: { file?: unknown }): HttpError | null {
  if (problem.kind === "declined") return new HttpError(422, ask.file ? DECLINED_FILE : DECLINED);
  if (problem.kind === "cut_off") return new HttpError(502, ask.file ? "The AI's answer was cut off before it finished." : CUT_OFF);
  if (problem.kind === "empty") return new HttpError(502, EMPTY);
  if (problem.kind === "timeout") return new HttpError(504, ask.file ? "Reading it took too long." : "The AI took too long to answer. Try again.");
  return null;
}

function keyProblem(problem: OpenAiProblem, ask: Ask, model: string): HttpError {
  const about = answerProblem(problem, ask);
  if (about) return about;
  if (problem.kind === "key") return new HttpError(502, "The OpenAI key on the Apps page didn't work. Check that it was copied correctly.");
  if (problem.kind === "usage_limit") return new HttpError(502, "The OpenAI key on the Apps page is out of credit or at its spending limit. Add credit at platform.openai.com, then try again.");
  if (problem.kind === "model") return new HttpError(502, `The OpenAI key can't use ${model}. Pick another model under Apps → ChatGPT.`);
  if (problem.kind === "unsupported") return new HttpError(502, `${model} can't do that. Pick another model under Apps → ChatGPT.`);
  if (problem.kind === "busy") return new HttpError(429, BUSY);
  return new HttpError(502, HAD_A_PROBLEM);
}

async function saveOpenAiSettings(admin: Db, companyId: string, settings: OpenAiSettings): Promise<void> {
  const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).eq("company_id", companyId).eq("provider", "chatgpt");
  if (error) console.error("Couldn't save what was learned about the OpenAI key", companyId, error.message);
}

/**
 * Ask with the company's OpenAI key. What OpenAI turns down about the request itself is put right
 * once and remembered: a model that doesn't take reasoning effort is asked without it from then
 * on, a schema strict mode refuses is sent without strict mode, and a picked model that's gone is
 * replaced by one OpenAI lists now (unless OPENAI_MODEL names it).
 */
async function askOpenAiKey(env: Env, admin: Db, companyId: string, ai: Extract<CompanyAi, { service: "chatgpt" }>, ask: Ask): Promise<string> {
  let settings = ai.settings;
  const picked = pickModel(env, settings.models ?? [], settings.model) ?? settings.model;
  if (!picked) throw new HttpError(502, "Pick a model for your OpenAI key under Apps → ChatGPT.");
  let model: string = picked;
  let effort: OpenAiAsk["effort"] = settings.no_effort?.includes(model) ? null : ask.effort;
  let strict = true;
  for (let tries = 0; ; tries++) {
    try {
      return await askWithKey(ai.apiKey, { ...ask, model, effort, strict });
    } catch (error) {
      if (!(error instanceof OpenAiProblem)) throw error;
      if (tries < 3 && error.kind === "unsupported" && error.param?.startsWith("reasoning") && effort) {
        effort = null;
        settings = { ...settings, no_effort: [...new Set([...(settings.no_effort ?? []), model])].slice(-20) };
        await saveOpenAiSettings(admin, companyId, settings);
        continue;
      }
      if (tries < 3 && error.kind === "unsupported" && error.param?.startsWith("text") && ask.schema && strict) {
        strict = false;
        continue;
      }
      if (tries < 3 && error.kind === "model" && !env.OPENAI_MODEL) {
        const gone = model;
        const models = await listKeyModels(ai.apiKey).catch(() => null);
        const next: string | null = models ? pickModel(env, models, models.some((m) => m.slug === gone) ? gone : null) : null;
        if (models && next && next !== model) {
          settings = { ...settings, model: next, models };
          await saveOpenAiSettings(admin, companyId, settings);
          model = next;
          effort = settings.no_effort?.includes(model) ? null : ask.effort;
          continue;
        }
      }
      throw keyProblem(error, ask, model);
    }
  }
}
