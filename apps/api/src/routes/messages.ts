/**
 * Messaging: send an email or text to a client from the message center, and receive replies to
 * texts (Twilio webhook). Every message is recorded on the client's timeline; a text from a
 * contact's phone goes there too, and one from a number nobody knows is kept for the office to
 * attach to a client (services/inboundTexts.ts). A client who texts STOP has texts off
 * (clients.sms_opt_out_at) until they text START, and no number that texted STOP is texted
 * (sms_stops, services/textsOff.ts). The office turns texts off, and back on, for someone who
 * asked another way (POST /clients/:id/texts).
 */
import { OFFICE, SALES } from "@crewtavo/core";
import { asksToStopTexts, smsKeyword, STOP_HOWS } from "@crewtavo/core/marketing";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { addressHistory } from "../lib/address";
import { kickAutomations } from "../lib/background";
import { requireCompany, requireUser } from "../lib/auth";
import { safeEqual } from "../lib/crypto";
import { isEmail, renderEmail } from "../lib/email";
import { appUrl, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { sentToClient } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { inboundQuo, quoMessageFromPayload, verifyQuoDelivery } from "../lib/quo";
import { inboundAccounts } from "../lib/twilio";
import { adminClient } from "../lib/supabase";
import { companyAddress } from "../services/automations";
import { logoImage } from "../services/logo";
import { receiveText } from "../services/inboundTexts";
import { noteRefusedText, numberStopped, numberStoppedRefusal, phoneKey, setTexts, TextsRefusal, textsOffRefusal, textsOffTo } from "../services/textsOff";

export const messages = new Hono<AppEnv>();

messages.post("/messages/send", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(
    c,
    z.object({
      client_id: uuid,
      channel: z.enum(["email", "sms"]),
      to: z.string().trim().max(200).optional(),
      subject: z.string().trim().max(200).optional(),
      body: z.string().trim().min(1).max(10_000),
    }),
  );
  const { db, companyId } = c.var;
  const client = must(await db.from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", body.client_id).eq("company_id", companyId).maybeSingle(), "Client not found.");
  const company = must(await adminClient(c.env).from("companies").select("name, email, phone, address, settings").eq("id", companyId).maybeSingle());
  let result: { sent: boolean; id?: string; reason?: string };
  let to: string;
  if (body.channel === "email") {
    to = body.to || client.email || "";
    if (!isEmail(to)) throw new HttpError(400, `${client.display_name} has no valid email address.`);
    if (!body.subject) throw new HttpError(400, "Add a subject.");
    const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
    result = await sendEmail(c.env, { to, subject: body.subject, ...renderEmail({ companyName: company.name, logo: logoImage(appUrl(c), companyId, company.settings), text: body.body, footer }), replyTo: company.email ?? undefined, fromName: company.name }, companyId);
  } else {
    to = body.to || client.phone || "";
    if (!to) throw new HttpError(400, `${client.display_name} has no phone number.`);
    // Their own phone, after they texted STOP. Another number (a spouse's, say) is the office's to
    // text, unless that number texted STOP itself.
    if (textsOffTo(client, to)) throw new HttpError(400, textsOffRefusal(client.display_name));
    if (await numberStopped(adminClient(c.env), companyId, to)) throw new HttpError(400, numberStoppedRefusal(to));
    if (body.body.length > 1600) throw new HttpError(400, "Texts are limited to 1,600 characters.");
    result = await sendSms(c.env, { to, body: body.body, company: companyId });
    await noteRefusedText(adminClient(c.env), client, to, result, companyId);
  }
  const { data: row, error } = await db
    .from("messages")
    .insert({
      company_id: companyId, client_id: client.id, channel: body.channel, direction: "out", subject: body.channel === "email" ? body.subject : null,
      body: body.body, status: result.sent ? "sent" : "failed", external_id: result.id ?? null,
      recipients: [{ to, name: sentToClient(body.channel, to, client) ? client.display_name : to, ...(result.sent ? {} : { failed: true }) }],
    })
    .select("id")
    .single();
  if (error) throw dbError(error);
  if (!result.sent) throw new HttpError(502, `${result.reason ?? "It wasn't sent."} The message was saved as failed on the client's timeline.`);
  return c.json({ id: row.id, sent: true, to });
});

/**
 * The office's "Texts" switch on a client or one of their contacts (services/textsOff.ts setTexts):
 * off for someone who asked by phone, by email, in person or in a text that wasn't the keyword,
 * saying how they asked; back on only because they asked for that, and never over a STOP Twilio has.
 * For owners, admins and the office. Recorded with who set it.
 */
messages.post("/clients/:id/texts", requireUser, requireCompany(OFFICE), async (c) => {
  const clientId = param(c, "id");
  const body = await readJson(
    c,
    z.object({
      on: z.boolean(),
      contact_id: uuid.optional(),
      how: z.enum(STOP_HOWS).optional(),
      note: z.string().trim().max(500).optional(),
    }),
  );
  if (!body.on && !body.how) throw new HttpError(400, "Say how they asked for texts to stop.");
  const admin = adminClient(c.env);
  const { data: who } = await admin.from("profiles").select("full_name").eq("user_id", c.var.userId).maybeSingle();
  try {
    return c.json(await setTexts(admin, { companyId: c.var.companyId, clientId, contactId: body.contact_id ?? null, on: body.on, how: body.how ?? null, note: body.note ?? null, by: c.var.userId, byName: who?.full_name ?? null }));
  } catch (error) {
    if (error instanceof TextsRefusal) throw new HttpError(400, error.message);
    throw error;
  }
});

/** Twilio's request signature: base64(HMAC-SHA1(auth token, URL + sorted form params)). */
export async function twilioSignature(token: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

/**
 * Incoming texts (set this URL as the Twilio number's messaging webhook). Twilio signs each request
 * with the Auth Token of the account the number is in, so whose text it is comes from which token
 * signed it: a company's own account (the one the request's AccountSid and To name, lib/twilio.ts
 * inboundAccounts), whose texts are that company's alone, or the server's, whose number every
 * company without its own shares. A request no known token signed is refused.
 */
messages.post("/webhooks/twilio", async (c) => {
  const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
  const admin = adminClient(c.env);
  const accounts = await inboundAccounts(c.env, admin, form);
  if (!accounts.length) throw new HttpError(501, "Texting isn't configured.");
  // Twilio signs the exact address it posts to: APP_URL, or one this instance had before a switch.
  const signature = c.req.header("x-twilio-signature") ?? "";
  const signedBy = async (base: string) => {
    for (const account of accounts) if (safeEqual(await twilioSignature(account.token, `${base}/api/webhooks/twilio`, form), signature)) return account;
    return null;
  };
  let account = await signedBy(appUrl(c));
  for (const base of account ? [] : (await addressHistory(c.env)).origins) account ??= await signedBy(base);
  if (!account) throw new HttpError(403, "Bad signature.");

  const from = phoneKey(form.From);
  const body = (form.Body ?? "").slice(0, 10_000);
  if (!from || !body) return c.text("<Response/>", 200, { "Content-Type": "text/xml" });
  // STOP or START: what Twilio itself acted on when it says (Advanced Opt-Out), else the words.
  const optOut = (form.OptOutType ?? "").toUpperCase();
  const word = optOut === "STOP" ? "stop" : optOut === "START" ? "start" : optOut ? null : smsKeyword(body);
  // Not the keyword, but words that plainly ask to stop ("please stop texting me"): honoured as one.
  // Twilio did nothing about it, so it's kept as a phrase, which the office can lift if they ask.
  const phrase = !optOut && !word && asksToStopTexts(body);
  const keyword = phrase ? "stop" : word;
  // Filed under the client or contact whose number it is, or kept as from an unknown number
  // (services/inboundTexts.ts), for the companies on the account that signed it.
  const touched = await receiveText(admin, { from: form.From!, body, sid: form.MessageSid ?? null, keyword, phrase }, account.companies);
  for (const company of touched) kickAutomations(c, company);
  return c.text("<Response/>", 200, { "Content-Type": "text/xml" });
});

/**
 * Incoming texts from Quo (set this URL on a webhook for the number in Quo: Settings → Webhooks,
 * or the API, with the message.received event). Quo sends JSON; which generation the webhook
 * belongs to decides the shape — legacy deliveries carry the message in data.object and an
 * openphone-signature header, new ones carry it in data.resource/data.context with the
 * Standard Webhooks headers (lib/quo.ts) — and both are read and checked. Whose text it is
 * comes from the number that was texted: a company's own Quo connection that sends from it,
 * or the server's Quo (lib/quo.ts inboundQuo). When the company kept its webhook's signing
 * key with its connection, the delivery's signature is checked against it and a delivery it
 * didn't sign is refused; without a key there's nothing to check against, so the docs ask
 * for one. Other events (message.delivered) are acknowledged and left: delivery state isn't
 * tracked here yet.
 */
messages.post("/webhooks/quo", async (c) => {
  const raw = await c.req.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Not JSON.");
  }
  const type = (payload as { type?: string } | null)?.type;
  if (type !== "message.received") return c.json({ ok: true, ignored: type ?? null });
  const message = quoMessageFromPayload(payload);
  if (!message) return c.json({ ok: true, ignored: "message.received" });
  const admin = adminClient(c.env);
  const inbound = await inboundQuo(c.env, admin, message);
  if (!inbound.companies?.length && inbound.companies !== null) throw new HttpError(501, "Texting isn't configured for that number.");
  if (inbound.webhookKeys.length) {
    const headers = {
      legacy: c.req.header("openphone-signature"),
      id: c.req.header("webhook-id"),
      timestamp: c.req.header("webhook-timestamp"),
      signature: c.req.header("webhook-signature"),
    };
    let signed = false;
    for (const key of inbound.webhookKeys) if (await verifyQuoDelivery(key, headers, raw)) signed = true;
    if (!signed) throw new HttpError(403, "Bad signature.");
  }
  const body = message.body.slice(0, 10_000);
  const from = phoneKey(message.from);
  if (!from || !body) return c.json({ ok: true });
  // STOP or START as words (Quo has no carrier opt-out field like Twilio's): the keyword itself,
  // or words that plainly ask to stop, honoured the same way as on the Twilio webhook.
  const word = smsKeyword(body);
  const phrase = !word && asksToStopTexts(body);
  const keyword = phrase ? "stop" : word;
  const touched = await receiveText(admin, { from: message.from, body, sid: message.sid, keyword, phrase }, inbound.companies);
  for (const company of touched) kickAutomations(c, company);
  return c.json({ ok: true });
});
