/**
 * Voice reports (services/voiceReports.ts, integrations/transcribe.ts): the two pieces that
 * can be wrong on their own — reading work items out of the AI's answer without inventing
 * any, and asking OpenAI to transcribe a recording with the company's key. OpenAI is a
 * stand-in here: fetch is stubbed, and each test answers the request it expects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProblem } from "../src/integrations/openai";
import { transcribeAudio } from "../src/integrations/transcribe";
import { parseReportItems } from "../src/services/voiceReports";

afterEach(() => vi.unstubAllGlobals());

describe("parseReportItems", () => {
  it("reads a clean JSON array", () => {
    const items = parseReportItems('[{"title":"Paint the living room","detail":"Walls and ceiling, two coats","quantity":1,"unit":"ea"},{"title":"Trim","detail":"Baseboards throughout","quantity":120,"unit":"ft"}]');
    expect(items).toEqual([
      { title: "Paint the living room", detail: "Walls and ceiling, two coats", quantity: 1, unit: "ea" },
      { title: "Trim", detail: "Baseboards throughout", quantity: 120, unit: "ft" },
    ]);
  });

  it("reads an array wrapped in code fences, with words around it", () => {
    const items = parseReportItems('Here are the items:\n```json\n[{"title":"Fence repair","detail":"","quantity":2,"unit":"ea"}]\n```');
    expect(items).toEqual([{ title: "Fence repair", detail: "", quantity: 2, unit: "ea" }]);
  });

  it("gives nothing for an answer that isn't an array of items", () => {
    expect(parseReportItems("The estimator painted a fence.")).toEqual([]);
    expect(parseReportItems("")).toEqual([]);
    expect(parseReportItems('{"title":"Not an array"}')).toEqual([]);
    expect(parseReportItems("[not json]")).toEqual([]);
  });

  it("fills in what an item didn't say: one each, no detail", () => {
    expect(parseReportItems('[{"title":"Mulch the beds"}]')).toEqual([{ title: "Mulch the beds", detail: "", quantity: 1, unit: "ea" }]);
    expect(parseReportItems('[{"title":"Mulch","quantity":0,"unit":"  "}]')).toEqual([{ title: "Mulch", detail: "", quantity: 1, unit: "ea" }]);
    expect(parseReportItems('[{"title":"Mulch","quantity":"3","unit":7}]')).toEqual([{ title: "Mulch", detail: "", quantity: 1, unit: "ea" }]);
  });

  it("drops entries with no title, and entries that aren't objects", () => {
    expect(parseReportItems('[{"detail":"No title here"}, "a string", null, {"title":"  "}, {"title":"Real work"}]')).toEqual([
      { title: "Real work", detail: "", quantity: 1, unit: "ea" },
    ]);
  });

  it("caps the list at fifty items", () => {
    const many = JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ title: `Item ${i + 1}` })));
    const items = parseReportItems(many);
    expect(items).toHaveLength(50);
    expect(items[49]!.title).toBe("Item 50");
  });
});

describe("transcribeAudio", () => {
  const audio = { data: new Uint8Array([1, 2, 3]), contentType: "audio/mp4", fileName: "walkthrough.m4a" };

  function serve(answer: () => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer();
    });
    return calls;
  }

  it("posts the recording to OpenAI's transcription endpoint with the company's key", async () => {
    const calls = serve(() => Response.json({ text: "  Paint the kitchen walls.  " }));
    await expect(transcribeAudio("sk-test-key", audio)).resolves.toBe("Paint the kitchen walls.");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-key");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("walkthrough.m4a");
    expect(file.type).toBe("audio/mp4");
    expect(file.size).toBe(3);
  });

  it("maps a turned-down key to a key problem", async () => {
    serve(() => Response.json({ error: { code: "invalid_api_key", type: "invalid_request_error", message: "Incorrect API key provided." } }, { status: 401 }));
    const error = await transcribeAudio("sk-bad", audio).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiProblem);
    expect((error as OpenAiProblem).kind).toBe("key");
  });

  it("maps an empty balance to a usage-limit problem", async () => {
    serve(() => Response.json({ error: { code: "insufficient_quota", type: "insufficient_quota" } }, { status: 429 }));
    const error = await transcribeAudio("sk-test-key", audio).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiProblem);
    expect((error as OpenAiProblem).kind).toBe("usage_limit");
  });

  it("maps a server failure to an unavailable problem, from the status alone", async () => {
    serve(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await transcribeAudio("sk-test-key", audio).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiProblem);
    expect((error as OpenAiProblem).kind).toBe("unavailable");
  });

  it("treats an answer with no words in it as an empty problem", async () => {
    serve(() => Response.json({ text: "   " }));
    const error = await transcribeAudio("sk-test-key", audio).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiProblem);
    expect((error as OpenAiProblem).kind).toBe("empty");
  });
});
