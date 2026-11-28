# Answering missed calls with the AI Voice Agent

When nobody answers a call to the business's Quo number, Quo can forward that call to a
second number at an AI voice platform — Retell or Vapi, running OpenAI's realtime voice.
An agent on that number answers in the business's name. It greets the caller with two
paths:

- **Book a free estimate** — live, on the real calendar, in the same times the online
  booking form would offer.
- **Leave a message** — the agent takes the caller's name, number and what they need.

In between, it answers basic questions from the FAQs you give it in Crewtavo — hours,
areas served, what a visit covers, that kind of thing. When the call ends, the transcript,
a short summary, the outcome and any booking land in Crewtavo under **AI Calls** (the AI
Command Center), so the office sees every call the agent took without listening to a
voicemail box.

Crewtavo is built provider-agnostic: Retell and Vapi do the same job here, and the setup
below is the same either way apart from the names each platform uses. The voice itself is
the platform's, not Crewtavo's — the platform charges per minute for it. From the research
done on 2026-11-20, expect roughly **$0.08–$0.13 a minute all-in**; that is an estimate,
not a quote, and the platform's own pricing page is the number to trust.

## How the pieces connect

In words, left to right:

**Quo number** → *(call rings out unanswered, or comes in after hours)* → **the platform
number** → **the agent** — it speaks from the prompt and FAQs kept in Crewtavo under
**Apps → AI Voice Agent**, and while it talks it can call back into Crewtavo with two
tools: **check availability** (what times are free?) and **book appointment** (hold one
of those times for this caller) → **the call ends** → the platform sends an end-of-call
webhook to Crewtavo → Crewtavo files an **`ai_calls` record** (the call, its transcript
and its outcome) and, where the caller booked or left a message, the **booking or request
in the CRM** to go with it.

Nothing in that chain answers a call the office picks up. The agent only ever sees a call
Quo has already decided to forward.

## Wiring it up — Josue's checklist

Most of this is Crewtavo copying addresses into the platform and back. One step only you
can do — the first one — because the platform account, its number and its bill have to be
in your name, with your payment info.

1. **Create the platform account, in your own name.** Pick one: Retell at
   [retellai.com](https://www.retellai.com) or Vapi at [vapi.ai](https://vapi.ai). Sign
   up with your own details and add your payment method there. Crewtavo never sees that
   card and can't create this account for you.
2. **Connect it in Crewtavo.** Open **Apps → AI Voice Agent**, pick the platform you
   joined, paste the **API key** from that platform, and save. Saving generates your
   **tool token** and **webhook secret**, and the panel then shows the addresses the
   platform needs: the two tool URLs and the webhook URL. The API key is stored encrypted
   and never shown again.
3. **Take the agent setup file.** From that same panel, download or copy the **agent
   setup file**. It holds the agent's prompt, your greeting and FAQs, and its two tools,
   written out ready to paste into the platform. If you later edit the greeting or FAQs
   in Crewtavo, take a fresh copy — the platform only knows what you last pasted into it.
4. **Create the agent on the platform, from that file.** In Retell, create an agent; in
   Vapi, create an assistant — same thing, different word. Paste in the prompt from the
   setup file, then add the two tools with the URLs from the Crewtavo panel, each one
   carrying the header **`Authorization: Bearer <tool token>`** with the tool token from
   the panel. Then give the platform Crewtavo's end-of-call address:
   - **Vapi:** set the assistant's **server URL** to the webhook URL from the panel, and
     add the webhook secret as the **`x-voice-secret`** header.
   - **Retell:** set the agent's **webhook URL** to the webhook URL from the panel, and
     add the webhook secret as the **`x-voice-secret`** header where the platform lets
     you set webhook headers.

   Copy both values exactly as the panel shows them. A webhook URL or secret that is
   even one character off means calls happen but never reach Crewtavo.
5. **Give the agent a number, and tell Crewtavo about it.** In the platform, buy a phone
   number (or import one, if the platform offers that) and assign it to the agent you
   just made. Then go back to **Apps → AI Voice Agent** in Crewtavo, paste in the
   **agent ID** and **that number**, and switch the feature **on**.
6. **Tell Quo to forward missed calls to that number.** This is a Quo-side setting;
   Crewtavo can't flip it for you. In the Quo (OpenPhone) app, look for **Settings →
   Phone numbers**, tap **the business number**, and find its **call handling /
   forwarding** options — the exact wording varies by app version, so look for the
   setting that forwards a call when it **goes unanswered**, and the one for **after
   business hours**. Point both at the platform number from step 5. Leave the number
   itself, and what happens when someone does answer, exactly as they are.
7. **Test it end to end, twice.** Call the Quo number from another phone and let it ring
   out — don't answer it. When the agent picks up, book a test estimate with it. Then
   check two places in Crewtavo: the visit is **on the calendar**, and the call is in
   **AI Calls** with its transcript. Call again, let it ring out, and this time leave a
   message instead — then check the request has landed in the CRM. If either test is
   missing its second half, see Troubleshooting below before going live.

## What the office sees

**AI Calls** lists every call the agent took. Open one and you get:

| Field | What it is |
| --- | --- |
| Caller | The caller's name, where the agent got it, and their phone number. |
| Time | When the call came in, and how long it lasted. |
| Duration | Length of the call — this is also, roughly, what the platform billed for it. |
| Outcome | What the call came to — see below. |
| Summary | A short plain-language summary of the call. |
| Transcript | The conversation, line by line, as the platform heard it. |
| Recording | The call recording, where the platform supplies one. |
| Linked request / visit | The request or calendar visit the call created, if it created one — follow it straight to the booking. |

The **outcome** is one of:

- **booked** — the caller picked a time and the estimate is on the calendar.
- **message** — the caller left a message instead; it is filed as a request for the office.
- **faq** — the caller only asked questions the agent could answer, and needed nothing booked and left no message.
- **transferred** — the call was handed on. See the limit below: the agent cannot transfer to a person live, so this is rare and worth checking when you see it.
- **other** — a finished call that doesn't fit the outcomes above.
- **unknown** — Crewtavo couldn't tell what the call came to — usually a very short call, a hang-up, or a webhook that arrived without its end-of-call detail.

## Honest limits

- **It books only real times.** The agent offers exactly the times the online booking
  form would offer, from the same availability engine — no separate calendar, no times
  invented to be helpful. If a company has no booking form with pick-a-time booking, the
  agent can't book at all: it takes messages only, and the office books by hand.
- **It can't transfer to a human live.** There is no one for it to transfer to on the
  platform number. A caller who insists on a person becomes an **urgent message** for
  the office instead — the agent takes their details and flags it, and a person calls
  back.
- **The platform side is yours.** The account, the phone number and the per-minute
  billing are in your name at Retell or Vapi. Crewtavo holds only the API key you paste
  in, so it can read the setup back and receive the calls.
- **Quo forwarding is Quo's switch.** If forwarding is off in Quo, the agent hears
  nothing, however well everything else is wired. Turning it on, changing it and turning
  it off all happen in Quo (step 6 above).
- **It answers from what you gave it.** The agent knows the prompt and FAQs in
  **Apps → AI Voice Agent** and the live calendar — nothing else about the business.
  A question outside the FAQs gets a polite "the office can help with that" and, where
  the caller wants it, a message taken.

## Troubleshooting

| Problem | What to check, in order |
| --- | --- |
| **No calls appear in AI Calls at all** | 1. Is the feature switched **on** in **Apps → AI Voice Agent**, with the agent ID and platform number saved? 2. Is **missed-call forwarding actually set in Quo** (checklist step 6) — call the number and let it ring out to be sure the agent answers. 3. Does the **webhook URL** on the platform match the one in the Crewtavo panel, character for character? 4. Does the **`x-voice-secret`** header on the platform match the webhook secret in the panel? A mismatch is refused silently at the platform's end — the call still happens, it just never lands. |
| **Calls appear, but a booking doesn't land** | 1. Does the company have a **booking form with pick-a-time** booking? Without one the agent can only take messages (see Limits). 2. Was the time **already taken** by the time the agent tried to hold it? Then the agent offers another time, or takes a message if the caller won't pick one — check the call's transcript to see which happened. 3. Re-check the two **tool URLs** and the **`Authorization: Bearer <tool token>`** header on the platform against the panel. |
| **The agent gives a wrong answer** | Edit the **FAQs or greeting** in **Apps → AI Voice Agent**, then take a **fresh copy of the agent setup file** from the panel and paste the updated prompt into the agent on the platform. Editing Crewtavo alone doesn't change the agent — the platform runs the copy it was last given. |
| **The agent never answers** | The call isn't reaching the platform number: check Quo forwarding first (step 6), then, on the platform, that the number is still **assigned to the agent** and the account is in good standing — a platform account with no working payment method stops answering, and that bill is the platform's, not Crewtavo's. |

## Notes

- Calls the office answers never reach the agent and never appear in AI Calls — Quo
  keeps those, as before. AI Calls is only the forwarded calls.
- Changing platforms later means a new account, a new agent made from the same setup
  file, a new number (or the old one moved, if the platforms allow it), and Quo
  forwarding pointed at the new number. The calls already in AI Calls stay where they are.
