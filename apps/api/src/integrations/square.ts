/**
 * Square for a company: the payments side of lib/square.ts (which account, checked and kept).
 * A company connects its own Square developer app on the Apps page, or a deployment sets one
 * for everyone. Then a client pays an invoice from the Client Hub with a card form Square's
 * Web Payments SDK renders in the page (services/square.ts): the token it makes is charged
 * here, the payment is booked into the payments table exactly as a Stripe payment is (so the
 * invoice's totals, activity and accounting follow from the same triggers), and Square's
 * webhooks reconcile whatever the charge's own answer didn't settle.
 *
 * Which provider a client pays with is a company choice (Settings → Payments), defaulting to
 * the one connected most recently; an invoice keeps the provider it was sent with
 * (invoices.pay_provider, set when it leaves draft), so switching providers never strands an
 * open invoice — a Stripe-mirrored invoice stays payable in Stripe, a Square one in Square.
 * Stripe's code and data are untouched by all of this.
 */
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { companySquare, serverSquare, type SquareAccount } from "../lib/square";
import type { Db } from "../lib/supabase";
import { cents } from "../services/stripe";
import {
  squareApi,
  squareBooking,
  squareEventPayment,
  squareIdempotencyKey,
  squareNeedsBooking,
  squarePaymentRequest,
  squareStatus,
  SQUARE_MINIMUM_CENTS,
  SquareError,
  type SquarePayment,
} from "../services/square";
import { stripeAccess } from "./stripe";

export interface SquareAccess {
  account: SquareAccount;
  /** The company's own account, from the Apps page (rather than the deployment's). */
  own: boolean;
}

/** The Square account a company's client payments go through, if any. */
export async function squareAccess(env: Env, admin: Db, companyId: string): Promise<SquareAccess | null> {
  const own = await companySquare(env, companyId).catch(() => null);
  if (own) return { account: own, own: true };
  const server = serverSquare(env);
  return server ? { account: server, own: false } : null;
}

// ---------------------------------------------------------------------------------------------
// Which provider clients pay with
// ---------------------------------------------------------------------------------------------

export type PayProvider = "stripe" | "square";

/** One provider's standing for the choice: connected at all, and when its own account was connected. */
export interface ProviderStanding {
  connected: boolean;
  /** When the company's own account was connected (ms); a server-only account counts as long ago. */
  connectedAt: number;
}

/**
 * The provider clients pay with, from what's connected and what the company chose: the choice
 * in Settings → Payments (companies.settings.pay_provider) when that provider is connected,
 * else the one connected most recently, else none. Pure, so the rule is tested directly.
 */
export function choosePayProvider(input: {
  setting: unknown;
  stripe: ProviderStanding;
  square: ProviderStanding;
}): PayProvider | null {
  const setting = input.setting === "stripe" || input.setting === "square" ? input.setting : null;
  if (setting === "stripe" && input.stripe.connected) return "stripe";
  if (setting === "square" && input.square.connected) return "square";
  if (input.stripe.connected && input.square.connected) return input.square.connectedAt >= input.stripe.connectedAt ? "square" : "stripe";
  if (input.square.connected) return "square";
  if (input.stripe.connected) return "stripe";
  return null;
}

/** Each provider's standing for a company: its own connection's date, or the server's account. */
async function standings(env: Env, admin: Db, companyId: string): Promise<{ stripe: ProviderStanding; square: ProviderStanding }> {
  const [stripe, square, rows] = await Promise.all([
    stripeAccess(env, admin, companyId),
    squareAccess(env, admin, companyId),
    admin.from("integrations").select("provider, connected_at").eq("company_id", companyId).in("provider", ["stripe", "square"]).neq("status", "disconnected"),
  ]);
  const at = (provider: string) => {
    const row = (rows.data ?? []).find((r) => r.provider === provider);
    return row?.connected_at ? Date.parse(row.connected_at) : 0;
  };
  return {
    stripe: { connected: Boolean(stripe), connectedAt: stripe?.own ? at("stripe") : 0 },
    square: { connected: Boolean(square), connectedAt: square?.own ? at("square") : 0 },
  };
}

/** What the company chose in Settings → Payments, and what it comes to with what's connected. */
export async function payProviderChoice(env: Env, admin: Db, companyId: string): Promise<{ setting: PayProvider | null; active: PayProvider | null; stripe: boolean; square: boolean }> {
  const [{ data: company }, s] = await Promise.all([
    admin.from("companies").select("settings").eq("id", companyId).maybeSingle(),
    standings(env, admin, companyId),
  ]);
  const raw = (company?.settings as { pay_provider?: unknown } | null)?.pay_provider;
  const setting = raw === "stripe" || raw === "square" ? raw : null;
  return { setting, active: choosePayProvider({ setting, ...s }), stripe: s.stripe.connected, square: s.square.connected };
}

/** The provider clients pay with for a company (Settings → Payments, else most recently connected). */
export async function activePayProvider(env: Env, admin: Db, companyId: string): Promise<PayProvider | null> {
  return (await payProviderChoice(env, admin, companyId)).active;
}

/** Settings → Payments: the provider clients pay with from now on (open invoices keep theirs). */
export async function setPayProvider(admin: Db, companyId: string, provider: PayProvider): Promise<void> {
  const { data: company, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  const settings = (company?.settings ?? {}) as Record<string, unknown>;
  const { error: saved } = await admin.from("companies").update({ settings: { ...settings, pay_provider: provider } as never }).eq("id", companyId);
  if (saved) throw new Error(saved.message);
}

/**
 * The provider an invoice is paid with: the one locked on it when it was sent
 * (invoices.pay_provider) while that provider is still connected, else the company's active
 * one. An invoice that has left draft without a lock gets the active provider locked onto it
 * now, so a later switch can't move an invoice a client is already looking at.
 */
export async function payProviderForInvoice(
  env: Env,
  admin: Db,
  companyId: string,
  invoice: { id: string; status: string; pay_provider?: string | null },
): Promise<PayProvider | null> {
  const s = await standings(env, admin, companyId);
  const locked = invoice.pay_provider === "stripe" || invoice.pay_provider === "square" ? invoice.pay_provider : null;
  if (locked && (locked === "stripe" ? s.stripe.connected : s.square.connected)) return locked;
  const { data: company } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  const active = choosePayProvider({ setting: (company?.settings as { pay_provider?: unknown } | null)?.pay_provider, ...s });
  if (active && invoice.status !== "draft" && !locked) {
    await admin.from("invoices").update({ pay_provider: active }).eq("company_id", companyId).eq("id", invoice.id).is("pay_provider", null);
  }
  return active;
}

// ---------------------------------------------------------------------------------------------
// Paying an invoice from the Client Hub
// ---------------------------------------------------------------------------------------------

/** For the Client Hub: can this invoice be paid through Square, and is a Square payment for it on its way? */
export async function squareHubPayment(env: Env, admin: Db, companyId: string, invoiceId: string) {
  const access = await squareAccess(env, admin, companyId);
  if (!access) return { enabled: false, processing: false, application_id: null, location_id: null, environment: null };
  // A card payment settles in seconds; one still "on its way" an hour later is a charge whose
  // answer was lost, and the webhook (or a fresh try) settles it — it doesn't block paying.
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: rows } = await admin
    .from("square_payments")
    .select("status")
    .eq("company_id", companyId)
    .eq("invoice_id", invoiceId)
    .in("status", ["creating", "pending"])
    .gte("created_at", since)
    .limit(1);
  return {
    enabled: true,
    processing: Boolean(rows?.length),
    application_id: access.account.applicationId,
    location_id: access.account.locationId,
    environment: access.account.environment,
  };
}

interface InvoiceRow {
  id: string;
  number: number | null;
  client_id: string;
  status: string;
  balance_due: number | string;
}

/**
 * Charge a client's card token for what's owed on an invoice (plus the tip they chose), and
 * book the payment. The card itself never reaches Crewtavo: the Hub's form tokenized it with
 * Square's SDK. A completed charge is booked from its own answer; the webhook reconciles it
 * again (and settles one whose answer was lost) — processor_ref is unique, so never twice.
 */
export async function chargeSquareInvoice(
  env: Env,
  admin: Db,
  companyId: string,
  invoiceId: string,
  input: { sourceId: string; verificationToken?: string; tipCents: number; attempt: string },
): Promise<{ status: "completed" | "pending"; paymentId: string }> {
  const access = await squareAccess(env, admin, companyId);
  if (!access) throw new HttpError(501, "Online payments aren't set up.");
  const { account } = access;
  const [{ data: invoice }, { data: company }] = await Promise.all([
    admin.from("invoices").select("id, number, client_id, status, balance_due").eq("company_id", companyId).eq("id", invoiceId).maybeSingle(),
    admin.from("companies").select("currency").eq("id", companyId).maybeSingle(),
  ]);
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  const row = invoice as InvoiceRow;
  if (row.status === "void") throw new HttpError(409, "This invoice was cancelled, so it can't be paid.");
  if (row.status === "written_off") throw new HttpError(409, "This invoice isn't owed anymore.");
  if (row.status === "draft") throw new HttpError(409, "This invoice isn't ready yet.");
  const amountCents = cents(row.balance_due);
  if (amountCents <= 0) throw new HttpError(409, "This invoice is already paid.");
  if (amountCents + input.tipCents < SQUARE_MINIMUM_CENTS) {
    throw new HttpError(409, "What's left on this invoice is too small to pay online. Contact us to pay it.");
  }
  const currency = (company?.currency || "USD").toUpperCase();
  const idempotencyKey = squareIdempotencyKey(companyId, invoiceId, input.attempt);
  const { data: attemptRow, error: attemptError } = await admin
    .from("square_payments")
    .insert({
      company_id: companyId, invoice_id: invoiceId, location_id: account.locationId, status: "creating",
      amount: amountCents / 100, tip_amount: input.tipCents / 100, currency: currency.toLowerCase(), idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (attemptError) {
    // The same try sent again (its answer was lost on the way back): Square replays a charge
    // made with the same idempotency key, and so do we — settle from the first try's payment
    // instead of charging again.
    if (attemptError.code !== "23505") throw new HttpError(500, "Couldn't start the payment. Try again in a minute.");
    const { data: first } = await admin
      .from("square_payments")
      .select("id, square_payment_id, status")
      .eq("company_id", companyId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (!first?.square_payment_id) throw new HttpError(409, "This payment is already being made. Give it a moment, then check the invoice.");
    const { payment: original } = await squareApi<{ payment: SquarePayment }>({ token: account.accessToken, environment: account.environment }, "GET", `/payments/${first.square_payment_id}`);
    const settled = squareStatus(original.status);
    if (settled === "completed") await recordSquarePayment(env, admin, companyId, original);
    else if (settled === "failed" || settled === "canceled") {
      await admin.from("square_payments").update({ status: settled }).eq("id", first.id);
      throw new HttpError(402, "Your card was declined. Check the card and try again, or use another card.");
    }
    return { status: settled === "completed" ? "completed" : "pending", paymentId: original.id };
  }
  let payment: SquarePayment;
  try {
    const res = await squareApi<{ payment: SquarePayment }>({ token: account.accessToken, environment: account.environment }, "POST", "/payments", squarePaymentRequest({
      sourceId: input.sourceId,
      verificationToken: input.verificationToken,
      locationId: account.locationId,
      amountCents,
      tipCents: input.tipCents,
      currency,
      invoiceId,
      invoiceNumber: row.number,
      idempotencyKey,
    }));
    payment = res.payment;
  } catch (error) {
    await admin.from("square_payments").update({ status: "failed" }).eq("id", attemptRow.id);
    if (error instanceof SquareError) {
      // A declined card is the client's to fix; anything else is Square or us, and says less.
      if (error.category === "PAYMENT_METHOD_ERROR" || error.code?.includes("DECLINE") || error.code === "CARD_DECLINED") {
        throw new HttpError(402, `Your card was declined${error.message ? ` (${error.message})` : ""}. Check the card and try again, or use another card.`);
      }
      throw new HttpError(502, "Online payments aren't working right now. Try again in a few minutes, or contact us to pay.");
    }
    throw error;
  }
  const status = squareStatus(payment.status);
  await admin
    .from("square_payments")
    .update({ square_payment_id: payment.id, status, fee_amount: 0 })
    .eq("id", attemptRow.id);
  if (status === "completed") await recordSquarePayment(env, admin, companyId, payment);
  if (status === "failed" || status === "canceled") {
    throw new HttpError(402, "Your card was declined. Check the card and try again, or use another card.");
  }
  return { status: status === "completed" ? "completed" : "pending", paymentId: payment.id };
}

/**
 * Book a completed Square payment into the payments table — the same booking Stripe's
 * recordPayment makes, through the same triggers — and bring its square_payments row up to
 * date. Idempotent: a payment already booked (by the charge's answer, or an earlier delivery)
 * is only reconciled. Returns whether money was booked.
 */
export async function recordSquarePayment(env: Env, admin: Db, companyId: string, payment: SquarePayment): Promise<boolean> {
  const { data: link } = await admin
    .from("square_payments")
    .select("id, invoice_id, status")
    .eq("company_id", companyId)
    .eq("square_payment_id", payment.id)
    .maybeSingle();
  const invoiceId = link?.invoice_id ?? payment.reference_id ?? null;
  if (!invoiceId) return false;
  const { data: booked } = await admin.from("payments").select("id").eq("processor_ref", payment.id).maybeSingle();
  const status = squareStatus(payment.status);
  if (!squareNeedsBooking({ payment, bookedRef: Boolean(booked), rowStatus: link?.status ?? null })) {
    if (link && link.status !== status && status !== "pending") {
      await admin.from("square_payments").update({ status }).eq("id", link.id);
    }
    return false;
  }
  const { data: invoice } = await admin
    .from("invoices")
    .select("id, number, client_id, status")
    .eq("company_id", companyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return false;
  const booking = squareBooking(payment, {
    invoiceId: invoice.id,
    clientId: invoice.client_id,
    voided: invoice.status === "void",
    invoiceNumber: invoice.number,
  });
  if (!booking) return false;
  const { error } = await admin.from("payments").insert({ company_id: companyId, ...booking });
  // processor_ref is unique, so a race with the other path books it once; that isn't an error.
  if (error && error.code !== "23505") throw new Error(`Couldn't record a Square payment: ${error.message}`);
  if (link) {
    await admin.from("square_payments").update({ status: "completed", fee_amount: (booking.fee_amount as number) ?? 0 }).eq("id", link.id);
  } else {
    await admin.from("square_payments").insert({
      company_id: companyId, invoice_id: invoice.id, square_payment_id: payment.id, location_id: payment.location_id ?? null,
      status: "completed", amount: (booking.amount as number) ?? 0, tip_amount: (booking.tip_amount as number) ?? 0,
      fee_amount: (booking.fee_amount as number) ?? 0, currency: (payment.amount_money?.currency ?? "usd").toLowerCase(), idempotency_key: null,
    });
  }
  return !error;
}

// ---------------------------------------------------------------------------------------------
// Webhooks: payment updates Square sends (routes/public.ts verifies the signature first)
// ---------------------------------------------------------------------------------------------

/**
 * One Square webhook delivery for a company, already signature-checked: a payment that
 * completed is booked (the safety net for a charge whose answer never arrived, and the
 * settler for one that was pending), and a failed or canceled one is marked on its row.
 * Payments with no Crewtavo invoice behind them (taken at Square's own till, say) aren't
 * booked — they carry no invoice reference, so there's nothing honest to book them against.
 * Returns true when money was booked.
 */
export async function handleSquareEvent(env: Env, admin: Db, companyId: string, event: unknown): Promise<boolean> {
  const payment = squareEventPayment(event);
  if (!payment) return false;
  const status = squareStatus(payment.status);
  if (status === "completed") return recordSquarePayment(env, admin, companyId, payment);
  if (status === "failed" || status === "canceled") {
    await admin.from("square_payments").update({ status }).eq("company_id", companyId).eq("square_payment_id", payment.id);
  }
  return false;
}
