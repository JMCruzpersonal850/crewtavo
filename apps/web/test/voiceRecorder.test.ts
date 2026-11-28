/**
 * The voice walkthrough's pure pieces (features/field/voiceRecorder.ts): the recording format a
 * browser can make is picked in a fixed order with the browser's own default as the fallback,
 * a recording's file ending follows its type, and the timer reads as a plain clock.
 */
import { describe, expect, it } from "vitest";
import { extensionForMime, formatClock, pickRecorderMime } from "../src/features/field/voiceRecorder";

describe("pickRecorderMime", () => {
  it("prefers WebM when the browser can record it", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm");
  });

  it("falls to MP4 on a browser without WebM (Safari)", () => {
    expect(pickRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
  });

  it("falls to Ogg when only that is left", () => {
    expect(pickRecorderMime((m) => m === "audio/ogg")).toBe("audio/ogg");
  });

  it("returns \"\" (the browser's own default) when it supports none of them", () => {
    expect(pickRecorderMime(() => false)).toBe("");
  });

  it("keeps trying when the check itself throws on a type", () => {
    expect(
      pickRecorderMime((m) => {
        if (m === "audio/webm") throw new Error("unknown");
        return m === "audio/mp4";
      }),
    ).toBe("audio/mp4");
  });
});

describe("extensionForMime", () => {
  it("names each recording type", () => {
    expect(extensionForMime("audio/webm")).toBe("webm");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/ogg")).toBe("ogg");
  });

  it("ignores the codecs a browser adds to the type", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionForMime("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("falls back to m4a when the type is empty or unknown", () => {
    expect(extensionForMime("")).toBe("m4a");
    expect(extensionForMime("audio/x-something")).toBe("m4a");
  });
});

describe("formatClock", () => {
  it("reads as minutes and padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(59)).toBe("0:59");
    expect(formatClock(60)).toBe("1:00");
    expect(formatClock(83)).toBe("1:23");
    expect(formatClock(600)).toBe("10:00");
    expect(formatClock(3661)).toBe("61:01");
  });

  it("rounds part seconds down and never goes below zero", () => {
    expect(formatClock(83.9)).toBe("1:23");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});
