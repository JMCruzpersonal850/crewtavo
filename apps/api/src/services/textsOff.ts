/**
 * Texts to someone who texted STOP: Crewtavo doesn't send them. Two records hold it, both set by
 * the Twilio webhook in routes/messages.ts:
 *
 * - clients.sms_opt_out_at, for a client's own phone, as it always was. It's what the office sees
 *   on the client ("texted STOP"), and what review asks and automations go by.
 * - public.sms_stops, for any number that texted STOP to the company: the client's own again, and
 *   a contact's or a stranger's, which have no client row to carry it. No text goes to a number
 *   in it, whoever it's kept under, until that number texts START.
 *
 * When Twilio refuses a text because the number opted out (a STOP Crewtavo never saw), the number
 * is recorded the same way, and the client is marked too when it's their own phone.
 *
 * A client's own STOP is about their own phone. A text the office sends to another number (a
 * spouse's, a contact's, one typed in) isn't refused for it, unless that number texted STOP itself.
 */
import { textsOff, textsOffReason } from "@crewtavo/core/marketing";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import type { SendResult } from "../lib/notify";
import type { Db } from "../lib/supabase";

/** Twilio's error for a number that texted STOP. */
export const TWILIO_OPTED_OUT = 21610;

/** The last 10 digits, as the Twilio webhook matches a text to the clients it's from. */
export const phoneKey = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

/** The number texted is the client's own phone. */
export function isClientPhone(to: string | null | undefined, client: { phone?: string | null }) {
  const key = phoneKey(to);
  return key !== "" && key === phoneKey(client.phone);
}

/** A text to `to` isn't sent: it's the client's own phone, and they texted STOP. */
export const textsOffTo = (client: { phone?: string | null; sms_opt_out_at?: string | null }, to: string | null | undefined) => textsOff(client) && isClientPhone(to, client);

/** The number texted STOP to this company (public.sms_stops), so nothing is texted to it. */
export async function numberStopped(admin: Db, companyId: string, to: string | null | undefined): Promise<boolean> {
  const key = phoneMatchKey(to);
  if (!key) return false;
  const { data, error } = await admin.from("sms_stops").select("phone_key").eq("company_id", companyId).eq("phone_key", key).limit(1);
  if (error) throw new Error(`Couldn't read who texted STOP: ${error.message}`);
  return Boolean(data?.length);
}

/** The number texted STOP to the company, or Twilio said it had: remembered, once. True when that's news. */
export async function noteStop(admin: Db, companyId: string, phone: string | null | undefined): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const { data, error } = await admin
    .from("sms_stops")
    .upsert({ company_id: companyId, phone_key: key, phone: (phone ?? "").trim().slice(0, 40) }, { onConflict: "company_id,phone_key", ignoreDuplicates: true })
    .select("phone_key");
  if (error) throw new Error(`Couldn't record a STOP: ${error.message}`);
  return Boolean(data?.length);
}

/** The number texted START: it can be texted again. True when it had been stopped. */
export async function clearStop(admin: Db, companyId: string, phone: string | null | undefined): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const { data, error } = await admin.from("sms_stops").delete().eq("company_id", companyId).eq("phone_key", key).select("phone_key");
  if (error) throw new Error(`Couldn't clear a STOP: ${error.message}`);
  return Boolean(data?.length);
}

/**
 * After a text to `to` that wasn't sent: Twilio said the number texted STOP. With the company, the
 * number is remembered (sms_stops); and when it's the client's own phone, they have texts off from now.
 */
export async function noteRefusedText(admin: Db, client: { id: string; phone?: string | null }, to: string, result: SendResult, companyId?: string | null) {
  if (result.sent || result.code !== TWILIO_OPTED_OUT) return;
  if (companyId) await noteStop(admin, companyId, to).catch((error) => console.error(error instanceof Error ? error.message : error));
  if (!isClientPhone(to, client)) return;
  await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", client.id).is("sms_opt_out_at", null);
}

/** Why a text to a client who texted STOP isn't sent, when someone sends it by hand. */
export const textsOffRefusal = (name: string) => `${textsOffReason(name)} Send it by email instead.`;

/** Why a text to any other number that texted STOP isn't sent, when someone sends it by hand. */
export const numberStoppedRefusal = (to: string) => `${to} texted STOP, so Crewtavo can't text it until they text START.`;
