/**
 * Which Quo (formerly OpenPhone) account a company's texts go through, and Quo's REST calls.
 * The mirror of lib/twilio.ts for businesses that text from a Quo number instead:
 *
 *   1. The company's own account, connected on the Apps page (Apps → Quo): its API key
 *      AES-encrypted in integration_secrets (provider "quo"), the number it sends from in
 *      integrations.settings, as a company's own Twilio account is kept.
 *   2. Else the server's (QUO_API_KEY, QUO_PHONE_NUMBER_ID, QUO_FROM_NUMBER), if whoever
 *      installed it set one: every company without its own shares that number.
 *
 * Quo's API (https://www.quo.com/docs): base https://api.openphone.com/v1, the API key goes in
 * the Authorization header as it is. Sending is POST /messages with { content, from, to } —
 * `from` is the number's id (PN...) or the number itself in E.164. GET /phone-numbers lists the
 * workspace's numbers and their ids, which is how a key is checked before it's saved.
 *
 * Texts that come in arrive on the webhook Quo is given for the number (Settings → Webhooks in
 * Quo, or the API): events message.received and message.delivered. Quo runs two webhook
 * generations and a delivery can be either (docs: webhooks overview / migration guide):
 * legacy ones (made in the app before the new system, or with /v1/webhooks) carry the message
 * in data.object and one header, openphone-signature "hmac;1;<ms>;<base64 HMAC-SHA256 of
 * "<ms>.<raw body>", keyed by the base64-decoded key>"; new ones carry it in data.resource
 * (the text in resource.text, the participants in data.context) and Standard Webhooks headers
 * — webhook-id, webhook-timestamp (seconds), webhook-signature "v1,<base64 HMAC-SHA256 of
 * "<id>.<timestamp>.<raw body>">" — with a `whsec_`-prefixed key. Both are checked when a
 * company kept its webhook's key with its connection (routes/messages.ts).
 */
import { phoneE164 } from "@crewtavo/core/phone";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { adminClient, type Db } from "./supabase";

/** Non-secret, in integrations.settings. */
export interface QuoSettings {
  /** Quo's id for the sending number (PN...). Texts are sent with it as `from`. */
  phone_number_id: string;
  /** The sending number itself, in E.164, for showing and for matching incoming texts. */
  from_number: string;
}

/** What integration_secrets holds for it (an integrations/tokens.ts StoredSecret). */
interface QuoSecret {
  api_key?: string;
  extra?: { webhook_key?: string };
}

export interface QuoAccount {
  apiKey: string;
  /** The number texts go from: its Quo id (PN...) and the number itself in E.164. */
  phoneNumberId: string;
  from: string;
  /** The company's own account, not the server's. */
  own: boolean;
  /** integrations.status for the company's own: "connected", or "error" once Quo refused it. */
  status?: string;
  /** The webhook signing key the company kept with its connection, when it gave one. */
  webhookKey?: string;
}

const API = "https://api.openphone.com/v1";
const CACHE_MS = 60_000;
/** Quo not answering in time counts as unreachable. */
const TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

const cache = new Map<string, { at: number; value: QuoAccount | null }>();

export const forgetQuo = (companyId?: string) => {
  if (companyId) cache.delete(companyId);
  else cache.clear();
};

/** The server's own account, when its key and a number are set. */
export function serverQuo(env: Env): QuoAccount | null {
  const { QUO_API_KEY: apiKey, QUO_PHONE_NUMBER_ID: phoneNumberId, QUO_FROM_NUMBER: from } = env;
  return apiKey && phoneNumberId ? { apiKey, phoneNumberId, from: from ?? phoneNumberId, own: false } : null;
}

/** The company's own connected account, if any (cached for a minute; reminders send many at once). */
export async function companyQuo(env: Env, companyId: string): Promise<QuoAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "quo").maybeSingle(),
  ]);
  let value: QuoAccount | null = null;
  if (row.data && row.data.status !== "disconnected" && secret.data) {
    try {
      const kept = await decryptJson<QuoSecret>(env, secret.data.ciphertext);
      const settings = row.data.settings as unknown as QuoSettings | null;
      if (kept.api_key && settings?.phone_number_id && settings?.from_number) {
        value = {
          apiKey: kept.api_key,
          phoneNumberId: settings.phone_number_id,
          from: settings.from_number,
          own: true,
          status: row.data.status,
          ...(kept.extra?.webhook_key ? { webhookKey: kept.extra.webhook_key } : {}),
        };
      }
    } catch (error) {
      reportError(error, { feature: "quo" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** The account a company's texts go through: its own Quo, else the server's. Null when there's neither. */
export async function quoFor(env: Env, companyId?: string | null): Promise<QuoAccount | null> {
  const own = companyId ? await companyQuo(env, companyId).catch(() => null) : null;
  return own ?? serverQuo(env);
}

const auth = (apiKey: string) => ({ Authorization: apiKey });

/** One text through an account. Quo's answer, or null when it couldn't be reached. */
export function postQuoMessage(account: Pick<QuoAccount, "apiKey" | "phoneNumberId">, message: { to: string; body: string }, fetcher: FetchLike = fetch): Promise<Response | null> {
  const to = phoneE164(message.to) ?? message.to;
  return fetcher(`${API}/messages`, {
    method: "POST",
    headers: { ...auth(account.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ content: message.body, from: account.phoneNumberId, to: [to] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
}

export interface QuoNumber {
  /** Quo's id for the number (PN...). */
  id: string;
  /** The number itself, in E.164. */
  number: string;
  /** The name the number has in Quo, when it has one. */
  name: string | null;
}

export interface QuoCheck {
  /** The workspace's numbers, for the person connecting to pick the one texts go from. */
  numbers: QuoNumber[];
}

/** Why credentials can't be used, in words for the person connecting them. */
export class QuoProblem extends Error {}

/**
 * Checks an API key with Quo before it's saved: the workspace's numbers are read (free, and Quo
 * only answers the right key). Throws a QuoProblem that says what to fix.
 */
export async function checkQuo(input: { api_key: string }, fetcher: FetchLike = fetch): Promise<QuoCheck> {
  const apiKey = input.api_key.trim();
  if (!apiKey) throw new QuoProblem("Paste your Quo API key. It's in Quo under Settings → API.");
  const res = await fetcher(`${API}/phone-numbers`, { headers: auth(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!res) throw new QuoProblem("Couldn't reach Quo to check this key. Try again in a minute.");
  if (res.status === 401 || res.status === 403) {
    throw new QuoProblem("Quo didn't accept that API key. Copy it again from Settings → API in Quo, or make a new one there.");
  }
  if (!res.ok) throw new QuoProblem(`Quo couldn't check this key right now (error ${res.status}). Try again in a minute.`);
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; number?: string; name?: string }> };
  const numbers = (body.data ?? [])
    .filter((n) => n.id && n.number)
    .map((n) => ({ id: n.id!, number: n.number!, name: n.name ?? null }));
  if (!numbers.length) throw new QuoProblem("That key works, but this Quo workspace has no phone numbers. Add a number in Quo first, then connect it here.");
  return { numbers };
}

/**
 * The HMAC key bytes a kept signing secret stands for: Quo's secrets are base64 — the new
 * generation's with a `whsec_` in front of the base64, the legacy one's bare. Either form of
 * either secret decodes the same way, so a key kept with or without its prefix still works.
 */
function signingKeyBytes(webhookKey: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(webhookKey.trim().replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacBase64(keyBytes: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

/** A digest comparison that doesn't stop at the first different character. */
function sameSignature(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a webhook delivery is the one Quo signed, legacy generation: header
 * openphone-signature "hmac;1;<ms>;<base64 digest>", the digest HMAC-SHA256 over
 * "<ms>.<raw body>" with the webhook's key decoded from base64, and the timestamp no more
 * than five minutes old (docs: Validate legacy webhook signatures).
 */
export async function verifyQuoSignature(webhookKey: string, header: string, rawBody: string, now = Date.now()): Promise<boolean> {
  const parts = header.split(";");
  if (parts.length !== 4 || parts[0] !== "hmac" || parts[1] !== "1") return false;
  const timestamp = Number(parts[2]);
  const signature = parts[3] ?? "";
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 5 * 60_000) return false;
  const keyBytes = signingKeyBytes(webhookKey);
  if (!keyBytes) return false;
  return sameSignature(await hmacBase64(keyBytes, `${parts[2]}.${rawBody}`), signature);
}

/** The three headers a new-generation Quo delivery is signed with (Standard Webhooks). */
export interface QuoStandardHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/**
 * Whether a webhook delivery is the one Quo signed, new generation (docs: Validate webhook
 * signatures): headers webhook-id, webhook-timestamp (Unix *seconds*) and webhook-signature,
 * a space-separated list of "v1,<base64 digest>" entries (more than one while a key rotates);
 * the digest is HMAC-SHA256 over "<id>.<timestamp>.<raw body>" with the webhook's key — the
 * `whsec_…` value Quo returned when the webhook was created, its prefix not part of the key —
 * decoded from base64, and the timestamp no more than five minutes old.
 */
export async function verifyQuoStandardSignature(webhookKey: string, headers: QuoStandardHeaders, rawBody: string, now = Date.now()): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 5 * 60) return false;
  const keyBytes = signingKeyBytes(webhookKey);
  if (!keyBytes) return false;
  const expected = await hmacBase64(keyBytes, `${id}.${timestamp}.${rawBody}`);
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    if (sameSignature(expected, entry.slice(comma + 1))) return true;
  }
  return false;
}

/**
 * Whether a delivery is the one Quo signed, whichever generation sent it: a delivery that
 * carries the new headers is checked the new way, one that doesn't falls back to the legacy
 * openphone-signature. Which generation a webhook sends is fixed when the webhook is made,
 * and both kinds can point at this address at once (docs: Migrate from legacy webhooks —
 * "Code that verifies the legacy OpenPhone-Signature header rejects every new delivery").
 */
export async function verifyQuoDelivery(webhookKey: string, headers: QuoStandardHeaders & { legacy?: string }, rawBody: string, now = Date.now()): Promise<boolean> {
  if (headers.id || headers.timestamp || headers.signature) return verifyQuoStandardSignature(webhookKey, headers, rawBody, now);
  return verifyQuoSignature(webhookKey, headers.legacy ?? "", rawBody, now);
}

/**
 * A message as a Quo webhook carries it. The two generations carry it differently (docs:
 * Webhook event payloads): legacy deliveries put the whole message in data.object (from, to,
 * body, phoneNumberId on it); new ones put the message itself in data.resource (its text, no
 * participants) and the participants around it in data.context — senderIdentifier is who
 * texted, recipientIdentifiers the number(s) they texted, phoneNumberId the number's id.
 */
export interface QuoInboundMessage {
  from: string;
  to: string;
  body: string;
  /** Quo's message id (AC...). */
  sid: string | null;
  /** Quo's id for the number that was texted (PN...). */
  phoneNumberId: string | null;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const firstString = (value: unknown): string => (Array.isArray(value) ? asString(value[0]) : asString(value));

/** The message in a webhook delivery, or null when the delivery isn't a text that came in. */
export function quoMessageFromPayload(payload: unknown): QuoInboundMessage | null {
  const root = payload as { type?: string; data?: { object?: Record<string, unknown>; resource?: Record<string, unknown>; context?: Record<string, unknown> } } | null;
  if (!root || root.type !== "message.received") return null;
  const obj = root.data?.object ?? root.data?.resource;
  if (!obj) return null;
  // A message.received is an inbound text; a delivery that says otherwise isn't one to file.
  if (obj.direction !== undefined && obj.direction !== "incoming") return null;
  const context = root.data?.context ?? {};
  const from = asString(obj.from) || asString(context.senderIdentifier);
  const to = firstString(obj.to) || firstString(context.recipientIdentifiers) || asString(context.recipientIdentifier);
  const body = [obj.body, obj.text, obj.content].find((v) => typeof v === "string") as string | undefined;
  if (!from || !body) return null;
  return {
    from,
    to,
    body,
    sid: asString(obj.id) || null,
    phoneNumberId: asString(obj.phoneNumberId) || asString(context.phoneNumberId) || null,
  };
}

export interface InboundQuo {
  /** The companies the text can be for (null: the server's number, shared by every company without its own). */
  companies: string[] | null;
  /** Webhook signing keys kept by those companies (and the server's), to check the delivery against. */
  webhookKeys: string[];
}

/**
 * Whose text an incoming delivery is, by the number it was sent to: companies whose own Quo
 * connection sends from that number (by its Quo id, or the number itself), else the server's
 * account when the number is its. A delivery that names no known number matches nobody's own.
 */
export async function inboundQuo(env: Env, admin: Db, message: Pick<QuoInboundMessage, "to" | "phoneNumberId">): Promise<InboundQuo> {
  const companies: string[] = [];
  const webhookKeys: string[] = [];
  const toKey = phoneMatchKey(message.to);
  const { data, error } = await admin.from("integrations").select("company_id, settings").eq("provider", "quo").neq("status", "disconnected").limit(50);
  if (error) throw new Error(`Couldn't read which company a text is for: ${error.message}`);
  for (const row of data ?? []) {
    const settings = row.settings as unknown as QuoSettings | null;
    if (!settings) continue;
    const byId = message.phoneNumberId && settings.phone_number_id === message.phoneNumberId;
    const byNumber = toKey && phoneMatchKey(settings.from_number) === toKey;
    if (!byId && !byNumber) continue;
    companies.push(row.company_id);
    const own = await companyQuo(env, row.company_id).catch(() => null);
    if (own?.webhookKey) webhookKeys.push(own.webhookKey);
  }
  if (companies.length) return { companies, webhookKeys };
  const server = serverQuo(env);
  if (server && ((message.phoneNumberId && server.phoneNumberId === message.phoneNumberId) || (toKey && phoneMatchKey(server.from) === toKey))) {
    return { companies: null, webhookKeys: env.QUO_WEBHOOK_KEY ? [env.QUO_WEBHOOK_KEY] : [] };
  }
  return { companies: [], webhookKeys: [] };
}
