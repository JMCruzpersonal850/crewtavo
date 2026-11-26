# Texting with Quo

Quo (formerly OpenPhone) is a business phone system. A business that already texts its clients
from a Quo number can connect that number to Crewtavo, so visit reminders, on-my-way texts and
two-way conversations in Messages go from the number its clients already know — the same job
Twilio does for businesses on Twilio (Apps → Twilio). Quo has no sign-in flow for other apps:
an API key is its official way in, so connecting is a short guided setup on the Apps page.

## Connect Quo (Apps → Quo)

You need to be an owner or admin of the Quo workspace, and an owner or admin in Crewtavo.

1. In Quo, go to **Workspace Settings → API** and click **Generate API key**. Name it
   `crewtavo` (Quo doesn't allow spaces in key names) and copy the key — Quo shows it only
   once. The key has full access to the workspace, so treat it like a password.
2. In Crewtavo, open **Apps → Quo**, paste the key and press **Check this key**. Crewtavo reads
   your Quo numbers back from Quo (nothing is sent) — pick the number texts should go from,
   then **Connect**. The key is stored encrypted and never shown again.
3. For replies to land in Messages, give Quo Crewtavo's address: in Quo, open
   **Settings → Webhooks**, click **Create webhook**, paste the address the Quo page shows
   (it ends in `/api/webhooks/quo`) and choose the **message.received** event for your number.
4. In that webhook's details, click **⋯ → Reveal signing secret** and keep the key in
   Crewtavo under **Apps → Quo → Change account**. With it, Crewtavo checks the signature Quo
   puts on every delivery (`openphone-signature`, HMAC-SHA256) and refuses texts it didn't
   sign. Without it, incoming texts are accepted unchecked — add it before relying on this
   number for real clients.

In the US, Quo also requires your workspace's carrier registration to be complete before
texts sent through the API go out; Quo walks you through that in its own settings.

## How sending chooses

A text goes from, in order: the company's own Quo account when it connected one, then Twilio
as before (the company's own Twilio account, else the server's), then the server's Quo account
for companies with neither. Connecting Quo never changes a company that texts through Twilio.

Replies are filed exactly like Twilio's: on the client's timeline when the number is a
client's or a contact's, or kept under Unknown numbers in Messages. A texted STOP (or words
that plainly ask for texts to stop) turns texts off for that number, and START turns them back
on, whichever provider carried the text.

## Running it for everyone (server account)

Whoever runs a Crewtavo instance can give every company without its own account one shared
Quo number, with environment variables:

| Variable | What it is |
| --- | --- |
| `QUO_API_KEY` | An API key from the workspace that owns the number. |
| `QUO_PHONE_NUMBER_ID` | Quo's id for the number (PN…), from **Apps → Quo**'s check or the API's phone number list. Texts are sent with it as the sender. |
| `QUO_FROM_NUMBER` | The number itself, in E.164. Used to recognise the texts that come in to it. |
| `QUO_WEBHOOK_KEY` | The signing secret of the message webhook made for that number, when it has one. |

Point that number's webhook at `https://<your address>/api/webhooks/quo`, as above.

## Notes

- Texts only. Calls stay in Quo; nothing about a call is copied into Crewtavo.
- Quo's API lives at `https://api.openphone.com/v1` even after the rename, and the key goes
  in the `Authorization` header as it is (no `Bearer`). Developer docs: https://www.quo.com/docs
- Delivery receipts (`message.delivered`) are acknowledged but not tracked yet; a text's
  status in Crewtavo is what Quo answered when it was sent.
