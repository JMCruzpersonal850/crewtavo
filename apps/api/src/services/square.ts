/**
 * Square over its REST API (no SDK, so it runs anywhere), the mirror of services/stripe.ts.
 * Every request pins a Square-Version, so the objects we read have the same shape whatever the
 * account's default version is. Amounts are integer cents (Square's amount_money), as Stripe's are.
 *
 * Unlike Stripe, Square is only the card rail: no Square invoice mirrors a Crewtavo one. The
 * Client Hub takes the card itself (Square's Web Payments SDK tokenizes it in the browser, so a
 * card number never reaches this server) and CreatePayment charges the token. The pieces that
 * turn Square's objects into Crewtavo's — a payment request, a booking for the payments table,
 * a webhook's signature — are pure, so they're tested directly (apps/api/test/square.test.ts).
 */
import { createHash } from "node:crypto";
import { providerTimeout } from "../integrations/registry";
import { safeEqual } from "../lib/crypto";

export const SQUARE_VERSION = "2024-12-18";

/** Which Square a token belongs to: each developer app has a sandbox and a production side. */
export type SquareEnvironment = "sandbox" | "production";

export const squareEnvironment = (value: unknown): SquareEnvironment => (value === "sandbox" ? "sandbox" : "production");

/** Square's API for an environment. */
export const squareBase = (environment: SquareEnvironment) =>
  environment === "sandbox" ? "https://connect.squareupsandbox.com/v2" : "https://connect.squareup.com/v2";

/** What Square said went wrong: its first error's code and words, which a declined card carries too. */
export class SquareError extends Error {
  override name = "SquareError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly category?: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

/**
 * One API call, given up on after the time other providers get. Rate limits, Square's own 5xx
 * and no answer are retried twice for reads and for writes that carry an idempotency key
 * (Square replays the first result instead of doing it again). Other writes aren't sent again,
 * since Square may have done them anyway.
 */
export async function squareApi<T>(
  access: { token: string; environment: SquareEnvironment },
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  options: { idempotencyKey?: string; fetcher?: FetchLike } = {},
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.token}`,
    "Square-Version": SQUARE_VERSION,
    Accept: "application/json",
    ...(payload ? { "Content-Type": "application/json" } : {}),
  };
  const repeatable = method === "GET" || Boolean(options.idempotencyKey ?? body?.idempotency_key);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await fetcher(`${squareBase(access.environment)}${path}`, { method, headers, body: payload, signal: providerTimeout() });
      text = await response.text();
    } catch (error) {
      if (!repeatable || attempt >= 2) throw new SquareError(`Square didn't answer (${error instanceof Error ? error.message : String(error)})`, 0);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    const json = readJson(text) as { errors?: Array<{ category?: string; code?: string; detail?: string }> };
    if (response.ok) return json as T;
    const retry = (response.status === 429 || response.status >= 500) && attempt < 2 && repeatable;
    if (!retry) {
      const e = json.errors?.[0];
      throw new SquareError(e?.detail ?? `Square returned ${response.status}`, response.status, e?.code, e?.category);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

/** A body that isn't JSON (a proxy's error page, say) reads as empty. */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// The objects we read (Square-Version 2024-12-18; only the fields we use)
// ---------------------------------------------------------------------------------------------

export interface SquareLocation {
  id: string;
  name: string;
  status?: string;
  /** The currency this location takes (the account's country decides it). */
  currency?: string;
}

export interface SquareMoney {
  amount?: number;
  currency?: string;
}

export interface SquarePayment {
  id: string;
  /** PENDING, APPROVED, COMPLETED, CANCELED or FAILED. */
  status: string;
  amount_money?: SquareMoney;
  tip_money?: SquareMoney;
  total_money?: SquareMoney;
  /** What Square kept, once the payment settles. */
  processing_fee?: Array<{ amount_money?: SquareMoney }>;
  /** Where the Crewtavo invoice's id rides (Square has no arbitrary metadata on a payment). */
  reference_id?: string | null;
  note?: string | null;
  location_id?: string;
  /** The card the client paid with, when Square says (its brand and last four). */
  card_details?: { card?: { card_brand?: string; last_4?: string } | null } | null;
  created_at?: string;
}

/** A webhook delivery: the event's type, and the payment under data.object when it's about one. */
export interface SquareEvent {
  type: string;
  data?: { id?: string; object?: { payment?: SquarePayment } | null } | null;
}

/** The payment a webhook delivery carries, or null when it isn't about one. */
export function squareEventPayment(event: unknown): SquarePayment | null {
  const e = event as SquareEvent | null;
  if (!e || (e.type !== "payment.created" && e.type !== "payment.updated")) return null;
  const payment = e.data?.object?.payment;
  return payment?.id ? payment : null;
}

/** Our word for a Square payment's state (the square_payments status check). */
export type SquarePaymentStatus = "pending" | "completed" | "failed" | "canceled";

export function squareStatus(status: string | undefined): SquarePaymentStatus {
  switch (status) {
    case "COMPLETED":
    case "APPROVED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "canceled";
    default:
      return "pending";
  }
}

/** What Square kept from a payment, in cents (the sum of its processing fees). */
export const squareFeeCents = (payment: Pick<SquarePayment, "processing_fee">): number =>
  (payment.processing_fee ?? []).reduce((sum, fee) => sum + (fee.amount_money?.amount ?? 0), 0);

/** The least Square charges by card, in cents ($1, where Stripe's is $0.50). */
export const SQUARE_MINIMUM_CENTS = 100;

// ---------------------------------------------------------------------------------------------
// Taking a payment
// ---------------------------------------------------------------------------------------------

/**
 * The idempotency key for one try at paying an invoice: the same try (the client re-sends the
 * same attempt after a lost answer) makes the same key, so Square replays the first charge
 * instead of charging twice; a new try is a new key. Square caps keys at 45 characters.
 */
export function squareIdempotencyKey(companyId: string, invoiceId: string, attempt: string): string {
  return createHash("sha256").update(`${companyId}:${invoiceId}:${attempt}`).digest("hex").slice(0, 40);
}

export interface SquareChargeInput {
  /** The token the Web Payments SDK made from the client's card. */
  sourceId: string;
  /** The SCA verification token (verifyBuyer), when the SDK made one. */
  verificationToken?: string;
  locationId: string;
  /** What's owed on the invoice, in cents (the tip rides separately, as it does for Stripe). */
  amountCents: number;
  tipCents: number;
  currency: string;
  /** The Crewtavo invoice's id, carried as the payment's reference_id. */
  invoiceId: string;
  invoiceNumber: number | null;
  idempotencyKey: string;
}

/** A CreatePayment body: the amount is what's owed, the tip its own money, as Square keeps them. */
export function squarePaymentRequest(input: SquareChargeInput): Record<string, unknown> {
  return {
    source_id: input.sourceId,
    idempotency_key: input.idempotencyKey,
    location_id: input.locationId,
    amount_money: { amount: input.amountCents, currency: input.currency.toUpperCase() },
    ...(input.tipCents > 0 ? { tip_money: { amount: input.tipCents, currency: input.currency.toUpperCase() } } : {}),
    reference_id: input.invoiceId,
    note: `Crewtavo invoice #${input.invoiceNumber ?? ""}`.trim(),
    autocomplete: true,
    ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Booking a payment (the payments table's row, shared by the charge and the webhook)
// ---------------------------------------------------------------------------------------------

export interface SquareBookingContext {
  invoiceId: string;
  clientId: string;
  /** The invoice was voided after the money moved: the money is the client's, without an invoice. */
  voided: boolean;
  invoiceNumber: number | null;
}

/**
 * A completed Square payment as a row for the payments table — the same shape recordPayment
 * books for Stripe, so the invoice's totals, activity and accounting follow from it the same
 * way (the touch_invoice trigger recomputes what's owed). Null when the payment hasn't
 * completed or moved no money. processor_ref is the Square payment id, unique in the table:
 * whichever of the charge's answer and the webhook books first, the other finds it there.
 */
/** A payments-table row for a completed Square payment: the fields recordSquarePayment books. */
export interface SquareBooking {
  invoice_id: string | null;
  client_id: string;
  amount: number;
  tip_amount: number;
  method: string;
  processor: string;
  processor_ref: string;
  fee_amount: number;
  received_at: string;
  recorded_by: null;
  notes?: string;
}

export function squareBooking(payment: SquarePayment, ctx: SquareBookingContext): SquareBooking | null {
  if (squareStatus(payment.status) !== "completed") return null;
  const amount = payment.amount_money?.amount ?? 0;
  const tip = payment.tip_money?.amount ?? 0;
  if (amount <= 0 && tip <= 0) return null;
  return {
    invoice_id: ctx.voided ? null : ctx.invoiceId,
    client_id: ctx.clientId,
    amount: amount / 100,
    tip_amount: tip / 100,
    method: "card",
    processor: "square",
    processor_ref: payment.id,
    fee_amount: squareFeeCents(payment) / 100,
    received_at: payment.created_at ?? new Date().toISOString(),
    recorded_by: null,
    ...(ctx.voided ? { notes: `For invoice #${ctx.invoiceNumber}, which is void` } : {}),
  };
}

/**
 * Whether a Square payment still needs booking: the charge's answer and the webhook both
 * reconcile, and the one that finds the payment already in the payments table (or already
 * settled in square_payments) only brings its status and fee up to date. Pure, so the
 * idempotency rule is tested directly.
 */
export function squareNeedsBooking(input: { payment: SquarePayment; bookedRef: boolean; rowStatus: string | null }): boolean {
  if (squareStatus(input.payment.status) !== "completed") return false;
  if (input.bookedRef) return false;
  return input.rowStatus !== "completed";
}

// ---------------------------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------------------------

/**
 * Whether a webhook delivery is the one Square signed: header x-square-hmacsha256-signature is
 * the base64 HMAC-SHA256 of the notification URL the subscription was made for plus the raw
 * body, keyed by the subscription's signature key. The URL is part of what's signed and must
 * match the subscription byte-for-byte — a Crewtavo whose address changed refuses deliveries
 * until the subscription is remade for the new address (the panel shows the exact address).
 */
export async function verifySquareSignature(signatureKey: string, notificationUrl: string, rawBody: string, header: string | undefined | null): Promise<boolean> {
  if (!header || !signatureKey) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signatureKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(notificationUrl + rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  return safeEqual(expected, header.trim());
}
