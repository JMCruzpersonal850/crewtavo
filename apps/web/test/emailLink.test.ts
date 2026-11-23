/**
 * Opening an emailed sign-in, reset or invitation link (lib/emailLink.ts): with nobody signed in it
 * signs in, as it always has. With someone signed in, the link is redeemed apart from their sign-in
 * first, and a link for another account only takes its place when they say so.
 */
import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { accountName, readEmailLink, redeemEmailLink, type LinkAuth, type SwitchQuestion } from "../src/lib/emailLink";

const session = (id: string, email: string, more: Partial<Session["user"]> = {}) =>
  ({ access_token: `access-${id}`, refresh_token: `refresh-${id}`, user: { id, email, user_metadata: {}, ...more } }) as unknown as Session;
const OWNER = session("owner", "owner@greenlawn.example");
const SENDER = session("sender", "sender@greenlawn.example");

/** A sign-in client: the session it holds, and what it was asked to do. */
function client(holds: Session | null, opens: Session | null = null, error: unknown = null) {
  const log: string[] = [];
  const auth: LinkAuth = {
    getSession: async () => ({ data: { session: holds } }),
    verifyOtp: async ({ token_hash, type }) => (log.push(`verify ${type} ${token_hash}`), { data: { session: error ? null : opens }, error }),
    setSession: async ({ access_token }) => (log.push(`set ${access_token}`), { error: null }),
    signOut: async ({ scope }) => log.push(`sign out ${scope}`),
  };
  return { auth, log };
}
const link = readEmailLink("?token_hash=hash.sig&type=magiclink")!;

describe("an emailed link", () => {
  it("is read from the address, with its kind and whether it welcomes someone new", () => {
    expect(readEmailLink("?token_hash=abc&type=recovery&welcome=1")).toEqual({ tokenHash: "abc", type: "recovery", welcome: true });
    expect(readEmailLink("?token_hash=abc&type=sms")).toBeNull();
    expect(readEmailLink("?type=invite")).toBeNull();
  });

  it("signs in straight away with nobody signed in here", async () => {
    const main = client(null, SENDER);
    const ask = vi.fn();
    expect(await redeemEmailLink(link, { auth: main.auth, apart: () => client(null).auth, ask })).toEqual({ problem: null, kept: false });
    expect(main.log).toEqual(["verify magiclink hash.sig"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("goes straight through for the account that's signed in, with the link's fresh sign-in", async () => {
    const main = client(OWNER);
    const other = client(null, session("owner", "owner@greenlawn.example"));
    const ask = vi.fn();
    expect(await redeemEmailLink(link, { auth: main.auth, apart: () => other.auth, ask })).toEqual({ problem: null, kept: false });
    expect(main.log).toEqual(["set access-owner"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks before another account's link takes the place of the one signed in, naming both", async () => {
    const main = client(OWNER);
    const other = client(null, SENDER);
    const asked: SwitchQuestion[] = [];
    // They stay: nothing changes here, and the link's sign-in is ended.
    const stay = await redeemEmailLink(link, { auth: main.auth, apart: () => other.auth, ask: async (q) => (asked.push(q), false) });
    expect(asked).toEqual([{ current: "owner@greenlawn.example", link: "sender@greenlawn.example" }]);
    expect(stay).toEqual({ problem: null, kept: true });
    expect(main.log).toEqual([]);
    expect(other.log).toEqual(["verify magiclink hash.sig", "sign out local"]);

    // They switch: the link's sign-in takes this one's place.
    const switched = client(OWNER);
    expect(await redeemEmailLink(link, { auth: switched.auth, apart: () => client(null, SENDER).auth, ask: async () => true })).toEqual({ problem: null, kept: false });
    expect(switched.log).toEqual(["set access-sender"]);
  });

  it("leaves whoever is signed in as they are when the link has run out", async () => {
    const main = client(OWNER);
    const result = await redeemEmailLink(link, { auth: main.auth, apart: () => client(null, null, new Error("Token has expired or is invalid")).auth, ask: async () => true });
    expect(result).toEqual({ problem: "That link has expired or was already used. Ask whoever sent it for a new one.", kept: true });
    expect(main.log).toEqual([]);
  });

  it("names a sub's sign-in without an email of its own by their name", () => {
    expect(accountName(session("sub", "sub-1@subs.invalid", { user_metadata: { full_name: "Al's Paving" } }))).toBe("Al's Paving");
    expect(accountName(OWNER)).toBe("owner@greenlawn.example");
  });
});
