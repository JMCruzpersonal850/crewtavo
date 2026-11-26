/**
 * Square (services/square.ts, lib/square.ts, integrations/square.ts): the token is checked
 * with Square before it's kept (its locations are read back for the picker), a charge is
 * built the way Square takes it (the amount is what's owed, the tip its own money, one
 * idempotency key per try), a completed payment books into the payments table as Stripe's
 * does and never twice, the provider a client pays with follows the company's choice and
 * then the most recent connection, and a webhook delivery is only believed when its
 * signature — over the notification address itself plus the body — is the one Square's
 * subscription key makes. Square answers what each test gives it; no database is needed
 * for these pieces.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSquare, SquareProblem } from "../src/lib/square";
import { choosePayProvider } from "../src/integrations/square";
import {
  squareBooking,
  squareEventPayment,
  squareFeeCents,
  squareIdempotencyKey,
  squareNeedsBooking,
  squarePaymentRequest,
  squareStatus,
  verifySquareSignature,
  type SquarePayment,
} from "../src/services/square";

type FetchLike = typeof fetch;
const fetcher = (answer: (url: string, init?: RequestInit) => Response | Promise<Response>) => (async (url: string, init?: RequestInit) => answer(url, init)) as unknown as FetchLike;

const problem = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (error instanceof SquareProblem) return error.message;
    throw error;
  }
  throw new Error("Expected a SquareProblem.");
};

describe("checkSquare", () => {
  it("reads the account's locations back for the picker, on the token's own side of Square", async () => {
    const seen: { url?: string; auth?: string; version?: string } = {};
    const checked = await checkSquare(
      { access_token: " token-123 ", environment: "sandbox" },
      fetcher((url, init) => {
        seen.url = url;
        const headers = init?.headers as Record<string, string>;
        seen.auth = headers.Authorization;
        seen.version = headers["Square-Version"];
        return Response.json({
          locations: [
            { id: "L1", name: "Main Street", status: "ACTIVE", currency: "USD" },
            { id: "L2", name: "Old Shop", status: "INACTIVE", currency: "USD" },
          ],
        });
      }),
    );
    expect(seen.url).toBe("https://connect.squareupsandbox.com/v2/locations");
    expect(seen.auth).toBe("Bearer token-123");
    expect(seen.version).toBeTruthy();
    // The inactive location isn't offered: payments can't be taken at it.
    expect(checked.locations).toEqual([{ id: "L1", name: "Main Street", status: "ACTIVE", currency: "USD" }]);
  });

  it("says what to fix when Square refuses the token, and when there's no location", async () => {
    expect(await problem(checkSquare({ access_token: "nope", environment: "production" }, fetcher(() => new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "bad token" }] }), { status: 401 }))))).toMatch(/^Square didn't accept that token/);
    expect(await problem(checkSquare({ access_token: "ok", environment: "production" }, fetcher(() => Response.json({ locations: [] }))))).toMatch(/no active locations/);
    expect(await problem(checkSquare({ access_token: "  ", environment: "sandbox" }))).toMatch(/^Paste your Square access token/);
  });
});

describe("squarePaymentRequest", () => {
  it("charges what's owed as the amount and the tip as its own money, with the invoice as the reference", () => {
    const body = squarePaymentRequest({
      sourceId: "cnon:card-nonce-ok",
      verificationToken: "verf:123",
      locationId: "L1",
      amountCents: 12500,
      tipCents: 1500,
      currency: "usd",
      invoiceId: "inv-1",
      invoiceNumber: 1042,
      idempotencyKey: "key-1",
    });
    expect(body).toEqual({
      source_id: "cnon:card-nonce-ok",
      idempotency_key: "key-1",
      location_id: "L1",
      amount_money: { amount: 12500, currency: "USD" },
      tip_money: { amount: 1500, currency: "USD" },
      reference_id: "inv-1",
      note: "Crewtavo invoice #1042",
      autocomplete: true,
      verification_token: "verf:123",
    });
  });

  it("leaves the tip and the verification token out when there are none", () => {
    const body = squarePaymentRequest({
      sourceId: "cnon:card-nonce-ok",
      locationId: "L1",
      amountCents: 5000,
      tipCents: 0,
      currency: "USD",
      invoiceId: "inv-2",
      invoiceNumber: null,
      idempotencyKey: "key-2",
    });
    expect(body).not.toHaveProperty("tip_money");
    expect(body).not.toHaveProperty("verification_token");
  });
});

describe("squareIdempotencyKey", () => {
  it("is the same for the same try and different for a new one, within Square's length cap", () => {
    const a = squareIdempotencyKey("co-1", "inv-1", "attempt-1");
    expect(squareIdempotencyKey("co-1", "inv-1", "attempt-1")).toBe(a);
    expect(squareIdempotencyKey("co-1", "inv-1", "attempt-2")).not.toBe(a);
    expect(squareIdempotencyKey("co-1", "inv-2", "attempt-1")).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(45);
  });
});

const payment = (over: Partial<SquarePayment> = {}): SquarePayment => ({
  id: "pay_123",
  status: "COMPLETED",
  amount_money: { amount: 12500, currency: "USD" },
  tip_money: { amount: 1500, currency: "USD" },
  processing_fee: [{ amount_money: { amount: 380, currency: "USD" } }, { amount_money: { amount: 20, currency: "USD" } }],
  reference_id: "inv-1",
  location_id: "L1",
  created_at: "2026-11-25T12:00:00Z",
  ...over,
});

describe("squareBooking", () => {
  it("books a completed payment as Stripe's are booked: amount without the tip, the tip apart, Square's fee, the payment id as the reference", () => {
    expect(squareFeeCents(payment())).toBe(400);
    expect(squareBooking(payment(), { invoiceId: "inv-1", clientId: "cli-1", voided: false, invoiceNumber: 1042 })).toEqual({
      invoice_id: "inv-1",
      client_id: "cli-1",
      amount: 125,
      tip_amount: 15,
      method: "card",
      processor: "square",
      processor_ref: "pay_123",
      fee_amount: 4,
      received_at: "2026-11-25T12:00:00Z",
      recorded_by: null,
    });
  });

  it("books nothing for a payment that hasn't completed or moved no money", () => {
    const ctx = { invoiceId: "inv-1", clientId: "cli-1", voided: false, invoiceNumber: 1042 };
    expect(squareBooking(payment({ status: "PENDING" }), ctx)).toBeNull();
    expect(squareBooking(payment({ status: "FAILED" }), ctx)).toBeNull();
    expect(squareBooking(payment({ amount_money: { amount: 0 }, tip_money: { amount: 0 } }), ctx)).toBeNull();
  });

  it("a payment for a voided invoice is the client's money, without the invoice, with a note", () => {
    const booked = squareBooking(payment(), { invoiceId: "inv-1", clientId: "cli-1", voided: true, invoiceNumber: 1042 });
    expect(booked).toMatchObject({ invoice_id: null, notes: "For invoice #1042, which is void" });
  });
});

describe("squareNeedsBooking (webhook and charge answer reconcile, never twice)", () => {
  it("books a completed payment neither path has booked", () => {
    expect(squareNeedsBooking({ payment: payment(), bookedRef: false, rowStatus: "creating" })).toBe(true);
    expect(squareNeedsBooking({ payment: payment(), bookedRef: false, rowStatus: null })).toBe(true);
  });

  it("doesn't book again what either path already booked", () => {
    // The charge's answer booked it; the webhook finds the reference in the payments table.
    expect(squareNeedsBooking({ payment: payment(), bookedRef: true, rowStatus: "completed" })).toBe(false);
    expect(squareNeedsBooking({ payment: payment(), bookedRef: false, rowStatus: "completed" })).toBe(false);
  });

  it("doesn't book a payment that hasn't completed", () => {
    expect(squareNeedsBooking({ payment: payment({ status: "PENDING" }), bookedRef: false, rowStatus: "creating" })).toBe(false);
  });
});

describe("squareEventPayment", () => {
  it("reads the payment out of a payment.created / payment.updated delivery", () => {
    const event = { type: "payment.updated", data: { object: { payment: payment() } } };
    expect(squareEventPayment(event)?.id).toBe("pay_123");
    expect(squareEventPayment({ type: "refund.updated", data: { object: { payment: payment() } } })).toBeNull();
    expect(squareEventPayment({ type: "payment.created", data: { object: {} } })).toBeNull();
    expect(squareEventPayment(null)).toBeNull();
  });

  it("maps Square's statuses onto ours", () => {
    expect(squareStatus("COMPLETED")).toBe("completed");
    expect(squareStatus("APPROVED")).toBe("completed");
    expect(squareStatus("PENDING")).toBe("pending");
    expect(squareStatus("FAILED")).toBe("failed");
    expect(squareStatus("CANCELED")).toBe("canceled");
  });
});

describe("choosePayProvider", () => {
  const at = (connected: boolean, connectedAt = 0) => ({ connected, connectedAt });

  it("follows the company's choice while that provider is connected", () => {
    expect(choosePayProvider({ setting: "square", stripe: at(true, 200), square: at(true, 100) })).toBe("square");
    expect(choosePayProvider({ setting: "stripe", stripe: at(true, 100), square: at(true, 200) })).toBe("stripe");
  });

  it("defaults to the provider connected most recently", () => {
    expect(choosePayProvider({ setting: null, stripe: at(true, 100), square: at(true, 200) })).toBe("square");
    expect(choosePayProvider({ setting: null, stripe: at(true, 200), square: at(true, 100) })).toBe("stripe");
  });

  it("falls back when the chosen provider is gone, and to nothing when neither is connected", () => {
    expect(choosePayProvider({ setting: "square", stripe: at(true, 100), square: at(false) })).toBe("stripe");
    expect(choosePayProvider({ setting: "square", stripe: at(false), square: at(false) })).toBeNull();
    expect(choosePayProvider({ setting: null, stripe: at(true), square: at(false) })).toBe("stripe");
  });
});

describe("verifySquareSignature", () => {
  const key = "sig-key-123";
  const url = "https://crewtavo.example/api/webhooks/square/9b0e2f10-0000-4000-8000-000000000001";
  const body = JSON.stringify({ type: "payment.updated", data: { object: { payment: { id: "pay_123" } } } });
  const sign = (signedUrl: string, signedBody: string, signedKey = key) => createHmac("sha256", signedKey).update(signedUrl + signedBody).digest("base64");

  it("accepts the signature Square makes over the notification address and the body", async () => {
    expect(await verifySquareSignature(key, url, body, sign(url, body))).toBe(true);
  });

  it("refuses a signature made for another address (the URL is part of what's signed)", async () => {
    expect(await verifySquareSignature(key, url, body, sign("https://crewtavo.example/api/webhooks/square/other-company", body))).toBe(false);
    // The same delivery checked against a Crewtavo whose address gained a trailing slash.
    expect(await verifySquareSignature(key, `${url}/`, body, sign(url, body))).toBe(false);
  });

  it("refuses a changed body, another subscription's key, and a missing header", async () => {
    expect(await verifySquareSignature(key, url, `${body} `, sign(url, body))).toBe(false);
    expect(await verifySquareSignature(key, url, body, sign(url, body, "another-key"))).toBe(false);
    expect(await verifySquareSignature(key, url, body, undefined)).toBe(false);
    expect(await verifySquareSignature(key, url, body, "")).toBe(false);
  });
});
