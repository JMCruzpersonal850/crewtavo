/**
 * Which Square account a company's client payments go through. The mirror of lib/quo.ts for
 * businesses whose money already runs through Square instead of Stripe:
 *
 *   1. The company's own account, connected on the Apps page (Apps → Square): its access token
 *      AES-encrypted in integration_secrets (provider "square"), its Application ID and the
 *      location payments are taken at in integrations.settings, as a company's own Quo account
 *      is kept.
 *   2. Else the server's (SQUARE_ACCESS_TOKEN, SQUARE_APPLICATION_ID, SQUARE_LOCATION_ID), if
 *      whoever installed it set one: every company without its own shares that account.
 *
 * Square's API (https://developer.squareup.com/docs): base https://connect.squareup.com/v2
 * (sandbox: connect.squareupsandbox.com), the access token as a Bearer token, and a pinned
 * Square-Version header (services/square.ts). A developer app has a sandbox and a production
 * side, each with its own token; which side a token belongs to is part of the connection, and
 * GET /locations — the account's locations, which the person connecting picks from — is how a
 * token is checked before it's saved.
 *
 * Square sends payment updates to a webhook subscription the person connecting makes in the
 * Square Developer Dashboard (Square can't be provisioned by API the way Stripe's webhook
 * is): events payment.created and payment.updated, signed with the subscription's signature
 * key (services/square.ts verifySquareSignature), kept with the connection when it's given.
 */
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { squareApi, squareEnvironment, SquareError, type SquareEnvironment, type SquareLocation } from "../services/square";
import { adminClient } from "./supabase";

/** Non-secret, in integrations.settings. */
export interface SquareSettings {
  /** The developer app's Application ID (the browser's card form needs it; it isn't a secret). */
  application_id: string;
  /** The location payments are taken at (Square's id for it). */
  location_id: string;
  /** That location's name, for showing. */
  location_name: string | null;
  /** Which side of Square the token belongs to. */
  environment: SquareEnvironment;
}

/** What integration_secrets holds for it (an integrations/tokens.ts StoredSecret). */
interface SquareSecret {
  access_token?: string;
  extra?: { webhook_key?: string };
}

export interface SquareAccount {
  accessToken: string;
  applicationId: string;
  /** The location payments are taken at: its Square id and name. */
  locationId: string;
  locationName: string | null;
  environment: SquareEnvironment;
  /** The company's own account, not the server's. */
  own: boolean;
  /** integrations.status for the company's own: "connected", or "error" once Square refused it. */
  status?: string;
  /** The webhook subscription's signature key the company kept with its connection, when it gave one. */
  webhookKey?: string;
}

const CACHE_MS = 60_000;
/** Square not answering in time counts as unreachable (services/square.ts gives up sooner). */
type FetchLike = typeof fetch;

const cache = new Map<string, { at: number; value: SquareAccount | null }>();

export const forgetSquare = (companyId?: string) => {
  if (companyId) cache.delete(companyId);
  else cache.clear();
};

/** The server's own account, when its token, app and a location are set. */
export function serverSquare(env: Env): SquareAccount | null {
  const { SQUARE_ACCESS_TOKEN: accessToken, SQUARE_APPLICATION_ID: applicationId, SQUARE_LOCATION_ID: locationId } = env;
  return accessToken && applicationId && locationId
    ? { accessToken, applicationId, locationId, locationName: null, environment: squareEnvironment(env.SQUARE_ENVIRONMENT), own: false }
    : null;
}

/** The company's own connected account, if any (cached for a minute; a page load asks often). */
export async function companySquare(env: Env, companyId: string): Promise<SquareAccount | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "square").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "square").maybeSingle(),
  ]);
  let value: SquareAccount | null = null;
  if (row.data && row.data.status !== "disconnected" && secret.data) {
    try {
      const kept = await decryptJson<SquareSecret>(env, secret.data.ciphertext);
      const settings = row.data.settings as unknown as SquareSettings | null;
      if (kept.access_token && settings?.application_id && settings?.location_id) {
        value = {
          accessToken: kept.access_token,
          applicationId: settings.application_id,
          locationId: settings.location_id,
          locationName: settings.location_name ?? null,
          environment: squareEnvironment(settings.environment),
          own: true,
          status: row.data.status,
          ...(kept.extra?.webhook_key ? { webhookKey: kept.extra.webhook_key } : {}),
        };
      }
    } catch (error) {
      reportError(error, { feature: "square" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** The account a company's client payments go through: its own Square, else the server's. Null when there's neither. */
export async function squareFor(env: Env, companyId?: string | null): Promise<SquareAccount | null> {
  const own = companyId ? await companySquare(env, companyId).catch(() => null) : null;
  return own ?? serverSquare(env);
}

export interface SquareCheck {
  /** The account's locations, for the person connecting to pick the one payments are taken at. */
  locations: SquareLocation[];
}

/** Why credentials can't be used, in words for the person connecting them. */
export class SquareProblem extends Error {}

/**
 * Checks an access token with Square before it's saved: the account's locations are read
 * (free, and Square only answers the right token, on the side — sandbox or production — the
 * token belongs to). Throws a SquareProblem that says what to fix.
 */
export async function checkSquare(input: { access_token: string; environment: SquareEnvironment }, fetcher?: FetchLike): Promise<SquareCheck> {
  const token = input.access_token.trim();
  if (!token) throw new SquareProblem("Paste your Square access token. It's in your app in the Square Developer Dashboard, under Credentials.");
  let locations: SquareLocation[];
  try {
    const res = await squareApi<{ locations?: SquareLocation[] }>({ token, environment: input.environment }, "GET", "/locations", undefined, { fetcher });
    locations = res.locations ?? [];
  } catch (error) {
    if (error instanceof SquareError) {
      if (error.status === 401 || error.status === 403) {
        throw new SquareProblem(
          input.environment === "sandbox"
            ? "Square didn't accept that token on the sandbox side. Sandbox tokens come from your app's Sandbox section in the Developer Dashboard — or switch this to Production if the token is a live one."
            : "Square didn't accept that token. Copy it again from your app's Credentials in the Square Developer Dashboard, and check it's the production token (a sandbox token needs Sandbox chosen here).",
        );
      }
      if (error.status === 0) throw new SquareProblem("Couldn't reach Square to check this token. Try again in a minute.");
      throw new SquareProblem(`Square couldn't check this token right now (error ${error.status}). Try again in a minute.`);
    }
    throw error;
  }
  const usable = locations.filter((l) => l.id && l.name && l.status !== "INACTIVE");
  if (!usable.length) throw new SquareProblem("That token works, but this Square account has no active locations. Add a location in Square first, then connect it here.");
  return { locations: usable.map((l) => ({ id: l.id, name: l.name, status: l.status, currency: l.currency })) };
}
