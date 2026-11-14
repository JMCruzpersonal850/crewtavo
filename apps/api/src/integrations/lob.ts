/**
 * Lob (lob.com): postcards printed and mailed for a business, on its own Lob account and API key
 * (Apps → Lob), for postcard campaigns (services/postcards.ts). Lob bills the business per card.
 *
 *   Keys     A secret key starting test_ makes postcards Lob never prints or mails (its dashboard
 *            shows them, with a picture of each), live_ mails them. Which it is is kept with the
 *            connection (integrations.settings.mode) and with each campaign as it starts, so a
 *            campaign never mails from a key it didn't start with.
 *   Auth     HTTP Basic, the key as the user name and no password.
 *   Cards    POST /v1/postcards, one per client, with an Idempotency-Key header: the recipient's own
 *            key, so a request tried again (a timeout, a restart) gives back the card already made
 *            instead of mailing a second one. Lob keeps keys for 24 hours.
 *   Check    GET /v1/addresses?limit=1 (the account's saved addresses): free, and only answers the
 *            right key.
 *
 * Lob also checks US addresses on their own (POST /v1/us_verifications), billed per lookup on a live
 * key. Crewtavo doesn't call it: Lob checks each card's address as it's made, and a card it can't
 * deliver comes back refused with the reason, which the campaign shows for that client.
 */
import type { MailingAddress, PostcardSize } from "@crewtavo/core/postcards";

const API = "https://api.lob.com/v1";
/** Lob not answering in time counts as unreachable. */
const TIMEOUT_MS = 20_000;

type FetchLike = typeof fetch;

export type LobMode = "test" | "live";

/** Whether a key is Lob's test or live key, or null when it isn't one of Lob's secret keys. */
export function lobMode(key: string): LobMode | null {
  const k = key.trim();
  if (/^test_[A-Za-z0-9]{10,}$/.test(k)) return "test";
  if (/^live_[A-Za-z0-9]{10,}$/.test(k)) return "live";
  return null;
}

/** What integrations.settings holds for Lob: never the key, which is in integration_secrets. */
export interface LobSettings {
  mode: LobMode;
}

/**
 * Why Lob refused, in words for the office.
 *   retry    the same request may work later (Lob busy, or not answering);
 *   final    what to say instead once it's been tried for the last time, so a card that has given
 *            up doesn't go on saying it will be tried again;
 *   key      Lob called the key itself invalid: nothing will go until Lob is connected again;
 *   account  Lob refused the account, not this card (no verified payment method, a plan's limit):
 *            the next card would be refused too, but the key is fine.
 */
export class LobProblem extends Error {
  readonly status: number | null;
  readonly retry: boolean;
  readonly final: string | null;
  readonly key: boolean;
  readonly account: boolean;
  constructor(message: string, about: { status?: number | null; retry?: boolean; final?: string; key?: boolean; account?: boolean } = {}) {
    super(message);
    this.status = about.status ?? null;
    this.retry = about.retry ?? false;
    this.final = about.final ?? null;
    this.key = about.key ?? false;
    this.account = about.account ?? false;
  }
}

const auth = (key: string) => ({ Authorization: `Basic ${btoa(`${key.trim()}:`)}` });

/** Lob's own message and error code from an error answer ({"error": {"message", "code", "status_code"}}). */
async function lobSaid(res: Response): Promise<{ said: string; code: string }> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown; code?: unknown } } | null;
  return {
    said: typeof body?.error?.message === "string" ? body.error.message.trim().slice(0, 300) : "",
    code: typeof body?.error?.code === "string" ? body.error.code.trim().toLowerCase() : "",
  };
}

/** Lob calls the key itself invalid: by its code, or in its words when it gives no code. */
const keyInvalid = (code: string, said: string) => code === "invalid_api_key" || (!code && /api key/i.test(said) && /not valid|invalid/i.test(said));

/**
 * Lob's refusals of the account rather than the key or the card (its error reference,
 * help.lob.com/developer-docs/error-reference): what to do about each, in our words. Lob answers
 * these with 401 or 403 like a bad key, which they are not.
 */
const ACCOUNT_WORDS: Record<string, string> = {
  payment_method_unverified: "Lob needs a verified payment method on your account before it mails cards. Add a card or bank account in your Lob dashboard.",
  email_required: "Lob needs the email address on your account verified before it mails cards. Check your Lob account's email.",
  billing_address_required: "Lob needs a billing address on your account before it mails cards. Add one in your Lob dashboard.",
  feature_limit_reached: "Your Lob plan has reached its limit. Upgrade or raise the limit in your Lob dashboard.",
};

/** Our words for it, then Lob's own, so nothing Lob said is lost. */
const withLobs = (words: string, said: string) => (said ? `${words} Lob says: ${said}` : words);

/** A refused request in words: what to fix, and whether trying again could work. */
async function problemOf(res: Response): Promise<LobProblem> {
  const { said, code } = await lobSaid(res);
  const status = res.status;
  if (status === 429) return new LobProblem("Lob asked us to slow down. The rest go in a minute.", { status, retry: true, final: "Lob kept asking us to slow down, so this card wasn't made." });
  if (status >= 500 || status === 408) return new LobProblem("Lob had a problem on its end. It's tried again shortly.", { status, retry: true, final: "Lob had a problem on its end each time this card was tried, so it wasn't made." });
  if (keyInvalid(code, said)) {
    return new LobProblem("Lob says this API key isn't valid. Connect Lob again in Apps with a key from Settings → API Keys in your Lob dashboard.", { status, key: true });
  }
  if (status === 401 || status === 402 || status === 403 || code in ACCOUNT_WORDS) {
    return new LobProblem(withLobs(ACCOUNT_WORDS[code] ?? "Lob refused the request, and would refuse the next card too.", said || `error ${status}`), { status, account: true });
  }
  return new LobProblem(said ? `Lob refused this card: ${said}` : `Lob refused this card (error ${status}).`, { status });
}

/** Checks a key with Lob before it's kept. The key's mode, or a LobProblem saying what to fix. */
export async function checkLobKey(key: string, fetcher: FetchLike = fetch): Promise<{ mode: LobMode }> {
  const mode = lobMode(key);
  if (!mode) throw new LobProblem("That doesn't look like a Lob secret API key. It starts with test_ or live_, under Settings → API Keys in your Lob dashboard.");
  const res = await fetcher(`${API}/addresses?limit=1`, { headers: auth(key), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!res) throw new LobProblem("Couldn't reach Lob to check the key. Try again in a minute.");
  if (res.ok) return { mode };
  const { said, code } = await lobSaid(res);
  // The account's own trouble (no payment method, an unverified email) is said as Lob says it, not as a bad key.
  if (code in ACCOUNT_WORDS) throw new LobProblem(withLobs(ACCOUNT_WORDS[code]!, said), { status: res.status, account: true });
  if (res.status === 401 || res.status === 403 || keyInvalid(code, said)) {
    throw new LobProblem("Lob didn't accept that key. Copy the whole secret key again from Settings → API Keys in your Lob dashboard.", { status: res.status, key: true });
  }
  throw new LobProblem(`Lob couldn't check the key right now (error ${res.status}). Try again in a minute.`, { status: res.status, retry: true });
}

export interface LobAddress {
  name: string;
  address_line1: string;
  address_line2?: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_country: "US";
}

/** An address as Lob takes it. Lob's names are 40 characters at most, its lines 64. */
export function lobAddress(name: string, a: MailingAddress): LobAddress {
  return {
    name: name.trim().slice(0, 40),
    address_line1: a.line1.slice(0, 64),
    ...(a.line2 ? { address_line2: a.line2.slice(0, 64) } : {}),
    address_city: a.city.slice(0, 200),
    address_state: a.region.slice(0, 200),
    address_zip: a.postal_code,
    address_country: "US",
  };
}

export interface PostcardRequest {
  to: LobAddress;
  from: LobAddress;
  size: PostcardSize;
  /** HTML for each side, at the size with its bleed (packages/core/src/postcards.ts). */
  front: string;
  back: string;
  /** Shown in Lob's dashboard: the campaign's name. */
  description: string;
  /** Kept with the card at Lob, so it can be found from there: the campaign and the recipient. */
  metadata: Record<string, string>;
  /** The same for every try at one client's card. */
  idempotencyKey: string;
}

/**
 * The body of POST /v1/postcards. `use_type` is "marketing": Lob asks each card whether it's
 * marketing or operational mail (an account can set a default instead), and a campaign is
 * marketing. If Lob ever stops taking a field here, this is the one place it's built.
 */
export function postcardBody(input: PostcardRequest): Record<string, unknown> {
  return {
    description: input.description.slice(0, 255),
    to: input.to,
    from: input.from,
    size: input.size,
    front: input.front,
    back: input.back,
    use_type: "marketing",
    mail_type: "usps_first_class",
    metadata: Object.fromEntries(Object.entries(input.metadata).slice(0, 20).map(([k, v]) => [k.slice(0, 40), v.slice(0, 500)])),
  };
}

export interface MadePostcard {
  /** Lob's id for the card (psc_...). */
  id: string;
  /** When Lob expects it to arrive (YYYY-MM-DD), when it says. */
  expected_delivery_date: string | null;
  /** A PDF of the card as Lob rendered it, when it says (it may not be ready yet). */
  url: string | null;
}

/**
 * Makes one postcard. Throws a LobProblem when Lob refuses it, or when Lob can't be reached (retry:
 * the same idempotency key makes a second try safe).
 */
export async function createPostcard(key: string, input: PostcardRequest, fetcher: FetchLike = fetch): Promise<MadePostcard> {
  const res = await fetcher(`${API}/postcards`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify(postcardBody(input)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new LobProblem("Couldn't reach Lob. It's tried again shortly.", { retry: true, final: "Lob couldn't be reached each time this card was tried, so it wasn't made." });
  if (!res.ok) throw await problemOf(res);
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; expected_delivery_date?: unknown; url?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    throw new LobProblem("Lob's answer didn't say which card it made. It's tried again shortly.", { status: res.status, retry: true, final: "Lob's answers never said which card it made. Look for this client's card in your Lob dashboard before mailing them again." });
  }
  return {
    id: body.id,
    expected_delivery_date: typeof body.expected_delivery_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.expected_delivery_date) ? body.expected_delivery_date.slice(0, 10) : null,
    url: typeof body.url === "string" ? body.url : null,
  };
}
