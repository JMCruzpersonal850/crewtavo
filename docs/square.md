# Taking payments with Square

Square is a card payments service. A business whose money already runs through Square can
connect its Square account to Crewtavo, so clients pay invoices and deposits by card through
Square instead of having to move to Stripe — the same job Stripe does for businesses on
Stripe (Apps → Stripe). Square has no sign-in flow for other apps: a developer app's access
token is its way in, so connecting is a short guided setup on the Apps page.

Crewtavo stays the book of record: unlike Stripe, no Square invoice mirrors a Crewtavo one.
The Client Hub takes the card itself, with Square's Web Payments SDK rendering the card form
in the page (the card number never reaches Crewtavo's server), and Crewtavo charges the
resulting token with Square's Payments API and records the payment — amount, tip and the fee
Square kept — in the same payments table a Stripe payment lands in.

## Connect Square (Apps → Square)

You need to be signed in to Square (the same login as your Square seller account) and an
owner or admin in Crewtavo.

1. In the [Square Developer Dashboard](https://developer.squareup.com/apps), click
   **+ New App**, name it `Crewtavo`, and open it. (A developer app is free; it's how Square
   knows the token belongs to your setup.)
2. Open the app's **Credentials**. It has two sides, **Sandbox** and **Production**, each
   with its own Application ID and access token. Start with **Sandbox**: nothing real is
   charged there, and Square's test cards (for example `4111 1111 1111 1111`, any future
   expiry, any CVV) work end to end.
3. In Crewtavo, open **Apps → Square**, paste the **Application ID** and **access token** of
   the side you're connecting, pick that side, and press **Check this token**. Crewtavo reads
   your locations back from Square (nothing is charged) — pick the location payments are
   taken at, then **Connect**. The token is stored encrypted and never shown again.
   Connecting Square makes it the provider clients pay with (see below).
4. For payment updates to reach Crewtavo, give Square its address: in the Developer
   Dashboard, open your app → **Webhooks → Subscriptions → Add subscription**, paste the
   address the Square page shows (it ends in `/api/webhooks/square/<your company id>`)
   exactly as shown, name it `Crewtavo`, and choose the events **payment.created** and
   **payment.updated**.
5. Open the subscription, copy its **Signature key**, and keep it in Crewtavo under
   **Apps → Square → Change account**. Square signs every delivery with that key over the
   notification address itself plus the body, and Crewtavo refuses deliveries it didn't
   sign. Without it, payments are still recorded the moment a charge completes — the
   webhook is the safety net that reconciles a payment whose answer was lost, and settles
   one that was still on its way — so add it before relying on Square for real clients.

When sandbox works, use **Change account** and connect the **Production** side the same
way, with the production Application ID and token, before taking real payments.

## Which provider clients pay with

A company can have Stripe and Square connected at once. Clients pay through one of them:

- The choice in **Settings → Payments** ("Clients pay with"), when that provider is
  connected; otherwise the provider connected most recently. Connecting either one makes
  it the default, as the most recent connection.
- An invoice keeps the provider it was sent with (`invoices.pay_provider`, set when it
  leaves draft): switching providers never strands an open invoice. A Stripe-mirrored
  invoice stays payable in Stripe, and the Stripe sync leaves a Square-locked invoice
  alone. Saved cards and autopay authorizations stay with the provider they were made
  under — autopay itself is Stripe-only for now, so a company on Square charges finished
  work by sending the invoice, which the client pays in the Hub.

## How paying works

On a Square invoice, the Hub shows the tip choice (while tips are on) and Square's card
form. The client enters their card, Square's SDK verifies the buyer for the amount
(SCA/3DS, `CHARGE` intent) and returns a token; Crewtavo charges it with the amount owed
as `amount_money` and the tip as `tip_money`, the Crewtavo invoice's id as the payment's
`reference_id`, and an idempotency key made from the try the page identified — so a try
whose answer was lost replays instead of charging twice. A completed charge is booked
from its own answer; the `payment.updated` webhook books it again if that answer never
arrived, and `payments.processor_ref` (the Square payment id, unique) makes the second
booking a no-op. Square's minimum card charge is $1 (Stripe's is $0.50).

Quote deposits are a deposit invoice paid through the same Hub flow — see the Phase C note
in `routes/public.ts` (`collectDeposit`): its "pay online" gate is still Stripe-shaped, so
for now a Square company's deposit invoice is paid from its Hub page like any invoice,
rather than from the approval screen's hosted page.

## Running it for everyone (server account)

Whoever runs a Crewtavo instance can give every company without its own account one shared
Square account, with environment variables:

| Variable | What it is |
| --- | --- |
| `SQUARE_ACCESS_TOKEN` | An access token from the developer app that owns the account. |
| `SQUARE_APPLICATION_ID` | That app's Application ID (the browser's card form uses it; it isn't a secret). |
| `SQUARE_LOCATION_ID` | The location payments are taken at (Square's id for it), from **Apps → Square**'s check or the API's location list. |
| `SQUARE_ENVIRONMENT` | `sandbox` or `production` — which side the token belongs to (production when unset). |

A server account has no webhook subscription of its own here (subscriptions are per
company address), so its payments reconcile from the charge's answer alone.

## Notes

- Sandbox and production are separate worlds in Square: a sandbox token only answers on
  the sandbox API, and its locations, payments and webhook subscriptions don't exist in
  production. The webhook subscription has to be made on the same side as the connection.
- The notification address is part of the webhook signature: if this Crewtavo's public
  address changes, deliveries are refused until the subscription is remade for the new
  address the Apps page shows.
- Refunds, disputes and payout sync are not in this phase: a refund made in Square itself
  isn't yet brought back into Crewtavo (Stripe's are, by webhook). Payments taken at
  Square's own till arrive by webhook without a Crewtavo invoice reference and aren't
  booked — there's nothing honest to book them against.
