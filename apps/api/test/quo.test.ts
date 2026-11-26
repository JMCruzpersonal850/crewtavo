/**
 * Quo (lib/quo.ts, Apps → Quo): the API key is checked with Quo before it's kept (its numbers
 * are read back for the picker), a text goes out as Quo's API is shaped, a webhook delivery is
 * only believed when its signature is the one Quo's key makes, and the message is read out of a
 * message.received delivery. Quo answers what each test gives it; no database is needed for
 * these pieces.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkQuo, postQuoMessage, quoMessageFromPayload, verifyQuoSignature, QuoProblem } from "../src/lib/quo";

type FetchLike = typeof fetch;
const fetcher = (answer: (url: string, init?: RequestInit) => Response | Promise<Response>) => (async (url: string, init?: RequestInit) => answer(url, init)) as unknown as FetchLike;

const problem = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    if (error instanceof QuoProblem) return error.message;
    throw error;
  }
  throw new Error("Expected a QuoProblem.");
};

describe("checkQuo", () => {
  it("reads the workspace's numbers back for the picker", async () => {
    const seen: { url?: string; auth?: string } = {};
    const checked = await checkQuo(
      { api_key: " key-123 " },
      fetcher((url, init) => {
        seen.url = url;
        seen.auth = (init?.headers as Record<string, string>).Authorization;
        return Response.json({ data: [{ id: "PNabc", number: "+15405550100", name: "Main line" }, { id: "PNdef", number: "+15405550101" }] });
      }),
    );
    expect(seen.url).toBe("https://api.openphone.com/v1/phone-numbers");
    // The key as it is, no Bearer.
    expect(seen.auth).toBe("key-123");
    expect(checked.numbers).toEqual([
      { id: "PNabc", number: "+15405550100", name: "Main line" },
      { id: "PNdef", number: "+15405550101", name: null },
    ]);
  });

  it("says what to fix when Quo refuses the key, and when there's no number", async () => {
    expect(await problem(checkQuo({ api_key: "nope" }, fetcher(() => new Response("", { status: 401 }))))).toMatch(/^Quo didn't accept that API key/);
    expect(await problem(checkQuo({ api_key: "ok" }, fetcher(() => Response.json({ data: [] }))))).toMatch(/no phone numbers/);
    expect(await problem(checkQuo({ api_key: "ok" }, fetcher(() => new Response("", { status: 503 }))))).toBe("Quo couldn't check this key right now (error 503). Try again in a minute.");
  });
});

describe("postQuoMessage", () => {
  it("sends content, the number's id as from, and the recipient as a list", async () => {
    const seen: { url?: string; body?: unknown; auth?: string } = {};
    const res = await postQuoMessage(
      { apiKey: "key-123", phoneNumberId: "PNabc" },
      { to: "(540) 555-0100", body: "On our way" },
      fetcher((url, init) => {
        seen.url = url;
        seen.auth = (init?.headers as Record<string, string>).Authorization;
        seen.body = JSON.parse(String(init?.body));
        return Response.json({ data: { id: "ACmsg" } }, { status: 202 });
      }),
    );
    expect(seen.url).toBe("https://api.openphone.com/v1/messages");
    expect(seen.auth).toBe("key-123");
    expect(seen.body).toEqual({ content: "On our way", from: "PNabc", to: ["+15405550100"] });
    expect(res?.ok).toBe(true);
  });
});

describe("verifyQuoSignature", () => {
  const keyBytes = new Uint8Array(32).map((_, i) => i * 3 + 1);
  const key = Buffer.from(keyBytes).toString("base64");
  const sign = (timestamp: number, body: string) => createHmac("sha256", Buffer.from(keyBytes)).update(`${timestamp}.${body}`).digest("base64");

  it("accepts the signature Quo makes, and refuses everything else", async () => {
    const now = 1_730_000_000_000;
    const body = JSON.stringify({ type: "message.received" });
    const header = `hmac;1;${now};${sign(now, body)}`;
    expect(await verifyQuoSignature(key, header, body, now)).toBe(true);
    expect(await verifyQuoSignature(key, header, `${body} `, now)).toBe(false);
    expect(await verifyQuoSignature(key, `hmac;1;${now};${sign(now, "another body")}`, body, now)).toBe(false);
    expect(await verifyQuoSignature(key, "garbage", body, now)).toBe(false);
  });

  it("refuses a signature more than five minutes old", async () => {
    const now = 1_730_000_000_000;
    const body = "{}";
    const old = now - 6 * 60_000;
    expect(await verifyQuoSignature(key, `hmac;1;${old};${sign(old, body)}`, body, now)).toBe(false);
  });
});

describe("quoMessageFromPayload", () => {
  it("reads the message out of a message.received delivery", () => {
    const payload = {
      id: "evt1",
      type: "message.received",
      createdAt: "2026-11-25T12:00:00Z",
      data: { object: { id: "ACmsg", direction: "incoming", from: "+15405550163", to: ["+15405550100"], body: "Hello", phoneNumberId: "PNabc", status: "received" } },
    };
    expect(quoMessageFromPayload(payload)).toEqual({ from: "+15405550163", to: "+15405550100", body: "Hello", sid: "ACmsg", phoneNumberId: "PNabc" });
  });

  it("leaves other events, and a delivery with no text in it", () => {
    expect(quoMessageFromPayload({ type: "message.delivered", data: { object: { from: "+1", body: "x" } } })).toBeNull();
    expect(quoMessageFromPayload({ type: "message.received", data: { object: { from: "+1" } } })).toBeNull();
    expect(quoMessageFromPayload(null)).toBeNull();
  });
});
