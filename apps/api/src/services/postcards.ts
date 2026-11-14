/**
 * Postcard campaigns (Marketing → Campaigns), printed and mailed through the company's own Lob
 * account (integrations/lob.ts). The office writes a draft in the browser; Send snapshots who it
 * goes to (public.start_postcard_campaign), and the postcards task makes one card per client, every
 * minute and right after Send, until they're all made.
 *
 *   Once each     Every recipient is claimed with a token before its card is made and renewed right
 *                 before the request, as campaign emails are; each request carries the recipient's
 *                 own idempotency key, so a card tried again after a timeout or a restart is the one
 *                 Lob already made, never a second.
 *   Test or live  Which it is is read from the key itself each time it's used (lobMode), never from
 *                 what Apps says about it. Send refuses when the key isn't the kind the page said,
 *                 and the campaign keeps the kind it was sent with: if the key is the other kind
 *                 when a batch starts, the campaign stops rather than mail (or not mail) cards
 *                 nobody asked for.
 *   Never mailed  A client who opts out of marketing or is archived after Send is skipped, checked
 *                 right before their card. Uninstalling Marketing or disconnecting Lob stops the
 *                 campaign; installing it again mails nothing late.
 *   The front     Lob fetches the picture from this server while it makes the cards
 *                 (/api/public/postcards/<token>.jpg): a copy made at Send, re-encoded without EXIF
 *                 (a phone photo's location would say where the client lives), at an address that
 *                 names nothing. So this server's address has to be public, as for social posts.
 */
import { marketingOn } from "@crewtavo/core/marketing";
import { backFit, backHtml, frontHtml, mailable, messageProblem, POSTCARD_SIZE_INFO, postcardMessage, type AddressProblem, type MailingAddress, type PostcardSize } from "@crewtavo/core/postcards";
import type { Env } from "../env";
import { createPostcard, lobAddress, lobMode, LobProblem, type LobMode, type LobSettings } from "../integrations/lob";
import { loadSecret } from "../integrations/tokens";
import { randomId } from "../lib/crypto";
import { firstName } from "../lib/email";
import { dbError, HttpError, must } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { shareJpeg, ShareImageError } from "../lib/shareImage";
import { storedFile } from "../lib/storedFile";
import { adminClient, type Db } from "../lib/supabase";
import { imagesPublic } from "./social";

const BATCH = 25;
/** Lob takes far more than this; spaced so a big campaign never trips its limits. */
const SPACING_MS = 250;
/** Tries at one card before it's failed for good (Lob down, or not answering). */
export const MAX_ATTEMPTS = 5;
/** A front picture as uploaded or taken: a phone photo is a few MB. */
const FRONT_MAX_BYTES = 30_000_000;
/** Big enough to print sharp on the largest card (11 in across). */
const FRONT_MAX_PX = 3400;
export const MAX_POSTCARDS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const LOB_NOT_CONNECTED = "Lob isn't connected, so postcards can't be mailed. An owner or admin can connect it in Apps → Lob.";
export const PRIVATE_ADDRESS_POSTCARDS = "Crewtavo's address isn't public, so Lob can't fetch the picture for the front. Postcards need Crewtavo on a public https address.";
const MARKETING_OFF = "Marketing is off, so postcards can't be mailed. An owner or admin can install it again in Apps.";

export interface CompanyLob {
  key: string;
  /** What the key itself is: the only thing that decides whether cards are mailed. */
  mode: LobMode;
  /** What Apps → Lob says it is (integrations.settings.mode), which Send checks against the key. */
  labelled: LobMode | null;
}

/**
 * The company's Lob key, or null when Lob isn't connected. Test or live is the key's own (its
 * prefix), read from the very key that's handed back: the label kept beside it is written
 * separately, so it can be wrong after a save that half-failed, and is only ever compared.
 */
export async function companyLob(env: Env, admin: Db, companyId: string): Promise<CompanyLob | null> {
  const { data: row, error } = await admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "lob").maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.status === "disconnected") return null;
  const secret = await loadSecret(env, admin, companyId, "lob");
  const mode = secret?.api_key ? lobMode(secret.api_key) : null;
  return mode ? { key: secret!.api_key!, mode, labelled: (row.settings as unknown as LobSettings | null)?.mode ?? null } : null;
}

const keyKind = (mode: LobMode | null) => (mode === "live" ? "a live key" : mode === "test" ? "a test key" : "no key");

/** Why Send can't trust the key on file, or null: Apps says one kind and the key is the other. */
export function keyLabelProblem(lob: Pick<CompanyLob, "mode" | "labelled">): string | null {
  if (lob.labelled === lob.mode) return null;
  return `Apps → Lob says ${keyKind(lob.labelled)} is saved, but the key on file is ${keyKind(lob.mode)}, so nothing was sent. An owner or admin should connect Lob again in Apps.`;
}

type Company = { name: string; phone: string | null; website: string | null; address: unknown; slug: string | null; settings: unknown };

/** The company's return address as Lob takes it, or null when Lob wouldn't take it. Read as a client's is (mailable). */
export function returnAddress(company: Pick<Company, "name" | "address">): MailingAddress | null {
  const found = mailable(company.address as Record<string, unknown> | null);
  return typeof found === "object" ? found : null;
}

const RETURN_ADDRESS_WORDS: Record<AddressProblem, string> = {
  no_address: "Add your company's full address in Settings → Company first: Lob prints it on each card as the return address.",
  outside_us: "Your company's address in Settings → Company has to be in the US, with a ZIP code: Lob prints it on each card as the return address.",
  bad_state: "The state in your company's address (Settings → Company) isn't one Lob can read. Type the state's name or its two letters, like IL.",
  too_long: "A line of your company's address (Settings → Company) is longer than the 64 characters Lob takes. Shorten it.",
};

/** What's wrong with the company's own address as a return address, or null: every card would be refused over it. */
export function returnAddressProblem(company: Pick<Company, "address">): string | null {
  const found = mailable(company.address as Record<string, unknown> | null);
  return typeof found === "object" ? null : RETURN_ADDRESS_WORDS[found];
}

/**
 * {{link}} on a card: the business's booking form (its first active one), which someone can type in,
 * else its website, else nothing.
 */
export async function bookingLink(env: Env, admin: Db, companyId: string, company: Pick<Company, "slug" | "website">): Promise<string> {
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  if (base && company.slug) {
    const { data: form } = await admin.from("intake_forms").select("slug").eq("company_id", companyId).eq("active", true).order("created_at").limit(1).maybeSingle();
    if (form) return `${base}/book/${company.slug}/${form.slug}`;
  }
  return company.website ?? "";
}

/** The client the page previews a card for when the audience is empty, and whose card Send measures first. */
export const SAMPLE_NAME = "Jordan Rivera";

/** A card's merge fields, for one client. */
export function postcardVars(company: Pick<Company, "name" | "phone">, name: string | null, link: string) {
  return { client: { first_name: firstName(name), name: name ?? "" }, company: { name: company.name, phone: company.phone ?? "" }, link };
}

// ---------------------------------------------------------------------------------------------
// Send and Stop
// ---------------------------------------------------------------------------------------------

/**
 * The front's public copy: the company's photo (its drawn-on copy unless the original was picked) or
 * the picture uploaded to the campaign, re-encoded as a JPEG without EXIF, stored beside the
 * campaign under a name nobody can guess.
 */
async function makeFront(admin: Db, companyId: string, campaign: { id: string; front_attachment_id: string | null; front_marked: boolean; front_path: string | null }) {
  let path = campaign.front_path;
  if (campaign.front_attachment_id) {
    const { data: photo } = await admin.from("attachments").select("path, marked_path").eq("company_id", companyId).eq("id", campaign.front_attachment_id).maybeSingle();
    if (!photo) throw new HttpError(400, "The photo for the front isn't there anymore. Pick another.");
    path = (campaign.front_marked && photo.marked_path) || photo.path;
  }
  if (!path) throw new HttpError(400, "Pick a picture for the front of the card.");
  if (!path.startsWith(`${companyId}/`)) throw new HttpError(400, "Pick a picture for the front of the card.");
  const bytes = await storedFile(admin, path, FRONT_MAX_BYTES);
  if (!bytes) throw new HttpError(400, "The picture for the front couldn't be read. Pick it again.");
  let made;
  try {
    made = await shareJpeg(bytes, { max: FRONT_MAX_PX });
  } catch (error) {
    if (error instanceof ShareImageError) throw new HttpError(400, "The front has to be a JPEG or PNG picture. Pick another.");
    throw error;
  }
  const token = randomId(24);
  const stored = `${companyId}/postcards/${campaign.id}/front-${token}.jpg`;
  const { error } = await admin.storage.from("files").upload(stored, made.body, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Couldn't save the front picture: ${error.message}`);
  return { token, path: stored };
}

/**
 * What stands in the way of mailing a draft, in the order someone would fix it, or null. `lob` is
 * the company's connection; the counting is the database's (at Send).
 */
export function sendProblem(input: { marketing: boolean; lob: boolean; publicAddress: boolean; returnAddressProblem: string | null; front: boolean; message: string; size: PostcardSize }): string | null {
  if (!input.marketing) return MARKETING_OFF;
  if (!input.lob) return LOB_NOT_CONNECTED;
  if (!input.publicAddress) return PRIVATE_ADDRESS_POSTCARDS;
  if (input.returnAddressProblem) return input.returnAddressProblem;
  if (!input.front) return "Pick a picture for the front of the card.";
  return messageProblem(input.message, input.size);
}

type AudienceRow = { client_id: string; display_name: string; address: unknown };
/** What the database sends at once at most (PostgREST's max rows). */
const AUDIENCE_PAGE = 1000;

/** Everyone a draft's card would go to now, read a page at a time (a campaign can pass 1,000). */
export async function audienceNow(db: Db, companyId: string, audience: unknown): Promise<AudienceRow[]> {
  const rows: AudienceRow[] = [];
  for (let from = 0; from <= MAX_POSTCARDS; from += AUDIENCE_PAGE) {
    const { data, error } = await db.rpc("postcard_audience", { p_company: companyId, p_audience: audience as never }).is("left_out", null).range(from, from + AUDIENCE_PAGE - 1);
    if (error) throw dbError(error);
    rows.push(...((data ?? []) as AudienceRow[]));
    if ((data?.length ?? 0) < AUDIENCE_PAGE) break;
  }
  return rows;
}

/**
 * The clients whose card wouldn't fit its words: the message is measured as each of them would get
 * it, their own name filled in, not as the one previewed. A card that doesn't fit is cut off at the
 * bottom when it's printed, so Send refuses and names them instead.
 */
export function unfitRecipients(size: PostcardSize, template: string, company: Pick<Company, "name" | "phone">, link: string, names: readonly string[]): string[] {
  const seen = new Map<string, boolean>();
  for (const name of names) {
    if (!seen.has(name)) seen.set(name, !backFit(size, postcardMessage(template, postcardVars(company, name, link))).fits);
  }
  return [...seen].filter(([, unfit]) => unfit).map(([name]) => name);
}

/** "for Ann Oak", "for Ann Oak and 2 other clients". */
const forClients = (names: readonly string[]) => `for ${names[0]}${names.length > 1 ? ` and ${(names.length - 1).toLocaleString("en-US")} other ${names.length === 2 ? "client" : "clients"}` : ""}`;

/**
 * Send: checks everything first, makes the front's public copy, then the database takes the audience
 * as it is now. A live key's campaign goes only with `confirm` naming how many cards it mails, the
 * number the office was shown, so a segment that grew meanwhile isn't mailed unasked. `shown` is the
 * kind of key the page said it is, test or live: when the key on file is the other kind, or isn't
 * what Apps says, nothing is sent.
 */
export async function startPostcards(env: Env, db: Db, companyId: string, id: string, confirm: number | null, shown: LobMode | null = null) {
  const admin = adminClient(env);
  const campaign = must(
    await db.from("postcard_campaigns").select("id, status, size, message, audience, front_attachment_id, front_marked, front_path").eq("company_id", companyId).eq("id", id).maybeSingle(),
    "Campaign not found.",
  );
  if (campaign.status !== "draft") throw new HttpError(409, "This campaign has already been sent.");
  const company = must(await admin.from("companies").select("name, phone, website, address, slug, settings").eq("id", companyId).maybeSingle()) as Company;
  const lob = await companyLob(env, admin, companyId);
  const size = campaign.size as PostcardSize;
  const link = await bookingLink(env, admin, companyId, company);
  const problem = sendProblem({
    marketing: marketingOn(company.settings as Record<string, unknown> | null),
    lob: Boolean(lob),
    publicAddress: imagesPublic(env),
    returnAddressProblem: returnAddressProblem(company),
    front: Boolean(campaign.front_attachment_id || campaign.front_path),
    // As the page previews it; each client's own card is measured below.
    message: postcardMessage(campaign.message, postcardVars(company, SAMPLE_NAME, link)),
    size,
  });
  if (problem) throw new HttpError(problem === LOB_NOT_CONNECTED || problem === MARKETING_OFF ? 409 : 400, problem);
  const mislabelled = keyLabelProblem(lob!);
  if (mislabelled) throw new HttpError(409, mislabelled);
  if (shown && shown !== lob!.mode) {
    throw new HttpError(409, `This page said ${keyKind(shown)}, but the Lob key on file is ${keyKind(lob!.mode)}, so nothing was sent. Reload the page and check before sending.`);
  }
  const summary = must(await db.rpc("postcard_audience_summary", { p_company: companyId, p_audience: campaign.audience })) as unknown as { count: number };
  if (!summary.count) throw new HttpError(400, "No one in this audience has a complete mailing address.");
  if (summary.count > MAX_POSTCARDS) throw new HttpError(400, `Postcard campaigns are limited to ${MAX_POSTCARDS.toLocaleString("en-US")} cards. Narrow the audience.`);
  if (lob!.mode === "live" && confirm !== summary.count) {
    throw new HttpError(409, `This mails ${summary.count.toLocaleString("en-US")} ${summary.count === 1 ? "postcard" : "postcards"} and Lob charges for each. Confirm that number to send.`);
  }
  const unfit = unfitRecipients(size, campaign.message, company, link, (await audienceNow(db, companyId, campaign.audience)).map((r) => r.display_name));
  if (unfit.length) {
    throw new HttpError(400, `The message is too long for the back of a ${POSTCARD_SIZE_INFO[size].label} card ${forClients(unfit)}: with their name filled in, the end would be cut off. Shorten it or pick a bigger card.`);
  }
  const front = await makeFront(admin, companyId, campaign);
  const { data: count, error } = await admin.rpc("start_postcard_campaign", { p_campaign: id, p_mode: lob!.mode, p_image_token: front.token, p_image_path: front.path, p_max: MAX_POSTCARDS });
  if (error) {
    await admin.storage.from("files").remove([front.path]);
    if (error.code === "55000") throw new HttpError(409, "This campaign has already been sent.");
    if (error.code === "22023") throw new HttpError(400, `${error.message}.`);
    throw dbError(error);
  }
  return { status: "sending" as const, recipients: count as number, mode: lob!.mode };
}

/** Stop: what isn't made yet isn't. Cards Lob already made are mailed (Lob can cancel them for a while, from its dashboard). */
export async function stopPostcards(env: Env, db: Db, companyId: string, id: string) {
  const campaign = must(await db.from("postcard_campaigns").select("id, status").eq("company_id", companyId).eq("id", id).maybeSingle(), "Campaign not found.");
  if (campaign.status !== "sending") throw new HttpError(409, "Only a campaign being mailed can be stopped.");
  const { error } = await adminClient(env).rpc("stop_postcard_campaign", { p_campaign: id, p_reason: "Stopped" });
  if (error) throw dbError(error);
  return { status: "cancelled" as const };
}

// ---------------------------------------------------------------------------------------------
// Making the cards (the postcards task)
// ---------------------------------------------------------------------------------------------

type Recipient = { id: number; client_id: string | null; name: string; address: unknown; idempotency_key: string; attempts: number; claim_token: string | null };

export async function processPostcards(env: Env, options: { campaignId?: string } = {}) {
  const admin = adminClient(env);
  let query = admin.from("postcard_campaigns").select("id, company_id, name, size, message, mode, image_token").eq("status", "sending").order("started_at").limit(5);
  if (options.campaignId) query = query.eq("id", options.campaignId);
  const { data: campaigns, error } = await query;
  if (error) throw new Error(error.message);

  const counts = { campaigns: campaigns?.length ?? 0, made: 0, failed: 0, skipped: 0, stopped: 0 };
  for (const campaign of campaigns ?? []) {
    const stop = async (reason: string) => {
      await admin.rpc("stop_postcard_campaign", { p_campaign: campaign.id, p_reason: reason });
      counts.stopped++;
    };
    const { data: company } = await admin.from("companies").select("name, phone, website, address, slug, settings").eq("id", campaign.company_id).maybeSingle();
    if (!company) continue;
    if (!marketingOn(company.settings as Record<string, unknown> | null)) {
      await stop("Marketing was turned off, so the rest weren't mailed.");
      continue;
    }
    const lob = await companyLob(env, admin, campaign.company_id).catch((e: unknown) => {
      reportError(e, { feature: "postcards" });
      return undefined;
    });
    if (lob === undefined) continue; // couldn't tell: tried again next run
    if (!lob) {
      await stop("Lob was disconnected, so the rest weren't mailed.");
      continue;
    }
    if (lob.mode !== campaign.mode) {
      await stop(lob.mode === "live"
        ? "The Lob key was changed to a live key after this was sent as a test, so nothing more was made. Send a copy to mail it for real."
        : "The Lob key was changed to a test key after this was sent, so the rest weren't mailed. Send a copy to mail them.");
      continue;
    }
    const from = returnAddress(company as Company);
    if (!from) {
      await stop("The company's address isn't complete anymore, and it's the cards' return address. Add it in Settings → Company and send a copy.");
      continue;
    }
    const base = (env.APP_URL ?? "").replace(/\/$/, "");
    const front = frontHtml(campaign.size as PostcardSize, `${base}/api/public/postcards/${campaign.image_token}.jpg`);
    const link = await bookingLink(env, admin, campaign.company_id, company as Company);

    const { data: claimed, error: claimError } = await admin.rpc("claim_postcard_recipients", { p_campaign: campaign.id, p_limit: BATCH });
    if (claimError) throw new Error(claimError.message);
    const batch = (claimed ?? []) as Recipient[];
    const token = batch[0]?.claim_token ?? "";
    let next = 0;
    try {
      for (const [index, r] of batch.entries()) {
        next = index;
        if (index) await sleep(SPACING_MS);
        // Checked right before each card: Stop stops the rest, and a client who opted out or was
        // archived since Send isn't mailed.
        const [live, client] = await Promise.all([
          admin.from("postcard_campaigns").select("status").eq("id", campaign.id).maybeSingle(),
          r.client_id ? admin.from("clients").select("status, marketing_opt_out").eq("id", r.client_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
        ]);
        if (live.error || client.error) break;
        if (live.data?.status !== "sending") {
          for (const rest of batch.slice(index)) await admin.rpc("finish_postcard_recipient", { p_id: rest.id, p_token: token, p_status: "skipped", p_error: "Campaign stopped" });
          counts.skipped += batch.length - index;
          next = batch.length;
          break;
        }
        const why = !client.data ? "Client was deleted" : client.data.marketing_opt_out ? "Opted out of marketing" : client.data.status === "archived" ? "Client was archived" : null;
        const to = mailable(r.address as Record<string, unknown>);
        if (why || typeof to !== "object") {
          await admin.rpc("finish_postcard_recipient", { p_id: r.id, p_token: token, p_status: "skipped", p_error: why ?? "No complete mailing address" });
          counts.skipped++;
          next = index + 1;
          continue;
        }
        // Send measured every card; a name, the phone number or the booking link may have changed
        // since. A card whose words no longer fit isn't printed with its end cut off.
        const message = postcardMessage(campaign.message, postcardVars(company as Company, r.name, link));
        if (!backFit(campaign.size as PostcardSize, message).fits) {
          await admin.rpc("finish_postcard_recipient", { p_id: r.id, p_token: token, p_status: "failed", p_error: "The message is too long for the back of the card with this client's name filled in, so their card wasn't made." });
          counts.failed++;
          next = index + 1;
          continue;
        }
        const { data: held, error: renewError } = await admin.rpc("renew_postcard_recipient", { p_id: r.id, p_token: token });
        if (renewError) break;
        if (!held) {
          next = index + 1; // another run has it now
          continue;
        }
        next = index + 1;
        try {
          const made = await createPostcard(lob.key, {
            to: lobAddress(r.name, to),
            from: lobAddress(company.name, from),
            size: campaign.size as PostcardSize,
            front,
            back: backHtml({ size: campaign.size as PostcardSize, message }),
            description: campaign.name,
            metadata: { crewtavo_campaign: campaign.id, crewtavo_recipient: String(r.id) },
            idempotencyKey: r.idempotency_key,
          });
          await admin.rpc("finish_postcard_recipient", { p_id: r.id, p_token: token, p_status: "made", p_lob_id: made.id, p_expected: made.expected_delivery_date ?? undefined });
          counts.made++;
        } catch (error) {
          if (!(error instanceof LobProblem)) throw error;
          if (error.key || error.account) {
            // Lob turned down the key, or the account (no payment method, a plan's limit): the next
            // card would be refused too, so the campaign stops with Lob's reason. Only a key Lob
            // calls invalid marks Lob as needing to be connected again: an account that needs a
            // payment method has a perfectly good key.
            if (error.key) await admin.from("integrations").update({ status: "error", last_error: error.message }).match({ company_id: campaign.company_id, provider: "lob" });
            await admin.rpc("release_postcard_recipients", { p_token: token, p_ids: batch.slice(index).map((x) => x.id) });
            await stop(`${error.message} The cards not made yet weren't mailed.`);
            next = batch.length;
            break;
          }
          if (error.retry && r.attempts + 1 < MAX_ATTEMPTS) {
            // The same key goes with it next time, so a card Lob did make isn't made twice.
            await admin.rpc("release_postcard_recipients", { p_token: token, p_ids: [r.id] });
            next = index + 1;
            break;
          }
          // Tried for the last time: said as over, not as "tried again shortly".
          await admin.rpc("finish_postcard_recipient", { p_id: r.id, p_token: token, p_status: "failed", p_error: error.retry ? (error.final ?? error.message) : error.message });
          counts.failed++;
        }
      }
    } finally {
      // Recipients this run claimed but didn't start on go back now, not when the claim runs out.
      const rest = batch.slice(next).map((r) => r.id);
      if (rest.length) await admin.rpc("release_postcard_recipients", { p_token: token, p_ids: rest });
    }
    await admin.rpc("count_postcard_campaign", { p_campaign: campaign.id });
  }
  return counts;
}

/** The front picture's public copy, for Lob to fetch: by its token alone, while the campaign is mailed or kept. */
export async function frontImage(admin: Db, token: string): Promise<Uint8Array | null> {
  const { data } = await admin.from("postcard_campaigns").select("image_path").eq("image_token", token).neq("status", "draft").maybeSingle();
  return data?.image_path ? storedFile(admin, data.image_path, FRONT_MAX_BYTES) : null;
}
