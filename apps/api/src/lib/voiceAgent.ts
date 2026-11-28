/**
 * The AI voice agent's connection for a company (Apps → AI Voice Agent): which platform answers
 * (Retell or Vapi), which agent and number it answers on, and the greeting and FAQs it was given.
 * The non-secret half lives in integrations.settings (provider "voice_agent"); the platform API
 * key and the two secrets Crewtavo makes for the platform to prove itself with — the webhook
 * secret it sends with each finished call, and the tool token it sends when it asks for openings
 * or books one — live AES-encrypted in integration_secrets (integrations/tokens.ts StoredSecret),
 * the way Quo's key is kept (lib/quo.ts).
 *
 * The tool token itself is never stored in the clear outside the secret: settings carries only
 * its keyed hash, so a tool call is matched to its company by hashing what it sent and comparing
 * against the stored hashes (companyIdForToolToken). A copy of the database alone can't be
 * searched for a working token.
 */
import type { Env } from "../env";
import type { StoredSecret } from "../integrations/tokens";
import { decryptJson, keyedHash, safeEqual } from "./crypto";
import { reportError } from "./monitoring";
import type { Db } from "./supabase";

/** Non-secret, in integrations.settings. */
export interface VoiceSettings {
  platform: "retell" | "vapi" | null;
  agent_id: string;
  phone_number: string;
  form_id: string | null;
  enabled: boolean;
  greeting: string;
  faqs: Array<{ question: string; answer: string }>;
  /** keyedHash of the tool token in the secret's extra, for matching a tool call to its company. */
  tool_token_hash: string | null;
}

/** What integration_secrets holds for it (an integrations/tokens.ts StoredSecret). */
export interface VoiceSecret {
  api_key?: string;
  extra?: { webhook_secret?: string; tool_token?: string };
}

export interface VoiceConnection {
  settings: VoiceSettings;
  secret: VoiceSecret | null;
  /** integrations.status: "connected", "disconnected", or another stored state. */
  status: string;
}

export const emptyVoiceSettings = (): VoiceSettings => ({
  platform: null,
  agent_id: "",
  phone_number: "",
  form_id: null,
  enabled: false,
  greeting: "",
  faqs: [],
  tool_token_hash: null,
});

/** Stored settings read defensively: a row written by an older shape still answers. */
export function voiceSettingsOf(raw: unknown): VoiceSettings {
  const s = (raw ?? {}) as Partial<VoiceSettings>;
  return {
    platform: s.platform === "retell" || s.platform === "vapi" ? s.platform : null,
    agent_id: typeof s.agent_id === "string" ? s.agent_id : "",
    phone_number: typeof s.phone_number === "string" ? s.phone_number : "",
    form_id: typeof s.form_id === "string" && s.form_id ? s.form_id : null,
    enabled: s.enabled === true,
    greeting: typeof s.greeting === "string" ? s.greeting : "",
    faqs: Array.isArray(s.faqs) ? s.faqs.filter((f) => f && typeof f.question === "string" && typeof f.answer === "string") : [],
    tool_token_hash: typeof s.tool_token_hash === "string" && s.tool_token_hash ? s.tool_token_hash : null,
  };
}

/** A company's voice-agent connection, or null when it has no integrations row at all. */
export async function loadVoiceSettings(env: Env, admin: Db, companyId: string): Promise<VoiceConnection | null> {
  const [row, kept] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "voice_agent").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "voice_agent").maybeSingle(),
  ]);
  if (row.error) throw new Error(`Couldn't read the voice agent connection: ${row.error.message}`);
  if (!row.data) return null;
  let secret: VoiceSecret | null = null;
  if (kept.data) {
    try {
      secret = await decryptJson<StoredSecret>(env, kept.data.ciphertext) as VoiceSecret;
    } catch (error) {
      reportError(error, { feature: "voice_agent" });
    }
  }
  return { settings: voiceSettingsOf(row.data.settings), secret, status: row.data.status };
}

/** Everything the platform needs is there: a platform, its API key, and the agent it answers as. */
export const voiceConfigured = (settings: VoiceSettings | null | undefined, secret: VoiceSecret | null | undefined): boolean =>
  Boolean(settings?.platform && settings?.agent_id && secret?.api_key);

/** Configured, and turned on: calls are answered and webhooks/tools act. */
export const voiceLive = (settings: VoiceSettings | null | undefined, secret: VoiceSecret | null | undefined): boolean =>
  voiceConfigured(settings, secret) && settings?.enabled === true;

/** The hash settings keep for a tool token. */
export const hashToolToken = (env: Env, token: string): Promise<string> => keyedHash(env, token);

/**
 * Which company a tool token belongs to, by its hash. PostgREST can filter on
 * settings->>tool_token_hash, but the candidates are few (one row per company that connected a
 * voice agent), so they're read and compared here instead: the same answer on every database
 * shape, and the comparison is constant-time.
 */
export async function companyIdForToolToken(env: Env, admin: Db, token: string): Promise<string | null> {
  if (!token) return null;
  const hash = await keyedHash(env, token);
  const { data, error } = await admin.from("integrations").select("company_id, settings").eq("provider", "voice_agent").neq("status", "disconnected").limit(200);
  if (error) throw new Error(`Couldn't read which company a voice tool call is for: ${error.message}`);
  for (const row of data ?? []) {
    const kept = voiceSettingsOf(row.settings).tool_token_hash;
    if (kept && safeEqual(kept, hash)) return row.company_id;
  }
  return null;
}

/** Whether a webhook delivery carried the company's webhook secret (header or query), in constant time. */
export function webhookSecretMatches(secret: VoiceSecret | null | undefined, provided: string | null | undefined): boolean {
  const expected = secret?.extra?.webhook_secret;
  return Boolean(expected && provided && safeEqual(expected, provided));
}
