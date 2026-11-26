/**
 * Paying an invoice through Square, in the page: Square's Web Payments SDK renders the card
 * fields itself (in Square's own frames, so the card number never reaches Crewtavo or its
 * server), tokenizes the card with the buyer's verification (SCA) for the amount being paid,
 * and the token — never the card — goes to Crewtavo, which charges it (POST pay-square). One
 * `attempt` id per try at an amount: a try whose answer was lost is replayed by the server
 * instead of charging twice, and a new amount or a failed try is a new attempt.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { formatMoneyCents } from "@/lib/format";

/** The pieces of Square's Web Payments SDK this form uses (loaded from Square's CDN, below). */
interface SquareCard {
  attach: (selector: string) => Promise<void>;
  tokenize: (verificationDetails?: unknown) => Promise<{ status: string; token?: string; verificationToken?: string; errors?: Array<{ message?: string }> }>;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
}
declare global {
  interface Window {
    Square?: { payments: (applicationId: string, locationId: string) => SquarePayments };
  }
}

const SDK_SRC: Record<"sandbox" | "production", string> = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};

/** Square's SDK script, loaded once per side of Square (sandbox and production are different files). */
const loading = new Map<string, Promise<void>>();
function loadSquare(environment: "sandbox" | "production"): Promise<void> {
  if (window.Square) return Promise.resolve();
  const src = SDK_SRC[environment];
  let job = loading.get(src);
  if (!job) {
    job = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Square's card form couldn't load."));
      document.head.appendChild(script);
    });
    loading.set(src, job);
  }
  return job;
}

export function SquarePayForm({
  square,
  amountCents,
  tip,
  currency,
  clientName,
  pay,
  onPaid,
}: {
  square: { application_id: string | null; location_id: string | null; environment: "sandbox" | "production" | null };
  /** What's owed plus the tip, in cents: what the card is charged and what verifyBuyer checks. */
  amountCents: number;
  /** The tip chosen, in dollars (the server re-checks it's still offered). */
  tip: number;
  currency: string;
  clientName?: string | null;
  /** POSTs the token to this invoice's pay-square route. */
  pay: (body: { source_id: string; verification_token?: string; tip: number; attempt: string }) => Promise<{ status: string }>;
  onPaid: () => void;
}) {
  const environment = square.environment ?? "production";
  const [card, setCard] = useState<SquareCard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<string>(crypto.randomUUID());
  // A new amount is a new try: the server replays a try by its id, and a replay must be for
  // the amount it first charged.
  useEffect(() => {
    attempt.current = crypto.randomUUID();
  }, [amountCents]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await loadSquare(environment);
        if (!live || !window.Square || !square.application_id || !square.location_id) return;
        const payments = window.Square.payments(square.application_id, square.location_id);
        const made = await payments.card();
        if (!live) return;
        await made.attach("#square-card-form");
        if (live) setCard(made);
      } catch {
        if (live) setLoadError("The card form couldn't load. Check your connection and reload this page, or contact us to pay.");
      }
    })();
    return () => {
      live = false;
    };
  }, [environment, square.application_id, square.location_id]);

  const submit = async () => {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await card.tokenize({
        amount: (amountCents / 100).toFixed(2),
        billingContact: { givenName: clientName ?? undefined },
        currencyCode: currency.toUpperCase(),
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
      });
      if (result.status !== "OK" || !result.token) {
        setError(new Error(result.errors?.[0]?.message ?? "That card couldn't be used. Check it and try again."));
        attempt.current = crypto.randomUUID();
        return;
      }
      await pay({
        source_id: result.token,
        ...(result.verificationToken ? { verification_token: result.verificationToken } : {}),
        tip,
        attempt: attempt.current,
      });
      onPaid();
    } catch (caught) {
      setError(caught);
      attempt.current = crypto.randomUUID();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="hub-card hub-pad no-print" aria-labelledby="hub-square-pay">
        <h2 id="hub-square-pay" className="hub-card-title">Pay by card</h2>
        {loadError ? (
          <p className="hub-fine" role="alert">{loadError}</p>
        ) : (
          <div id="square-card-form" style={{ minHeight: 110 }} aria-busy={!card} />
        )}
        <FormError error={error} />
      </section>
      {/* On a phone, kept in a bar at the bottom of the screen, like the Stripe Pay bar. */}
      <div className="hub-bar no-print" data-pinned="">
        {tip > 0 && (
          <div className="hub-bar-total">
            <span>With a {formatMoneyCents(tip)} tip</span>
            <strong>{formatMoneyCents(amountCents / 100)}</strong>
          </div>
        )}
        <Button variant="primary" size="lg" block loading={busy} disabled={!card || Boolean(loadError)} onClick={submit}>
          Pay {formatMoneyCents(amountCents / 100)} by card
        </Button>
        <span className="hub-secure"><Icon name="lock" size={13} />Secure checkout by Square</span>
      </div>
    </>
  );
}
