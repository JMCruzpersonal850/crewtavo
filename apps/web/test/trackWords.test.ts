/**
 * The live tracking page's words (features/public/trackWords.ts): the honesty label for how old
 * the crew's last reported place is, and the drive still to go.
 */
import { describe, expect, it } from "vitest";
import { ageWords, etaWords } from "../src/features/public/trackWords";

describe("how old the last update is, said plainly", () => {
  it("is just now under a minute, then minutes, then hours", () => {
    expect(ageWords(0)).toBe("just now");
    expect(ageWords(44)).toBe("just now");
    expect(ageWords(45)).toBe("1 minute ago");
    expect(ageWords(89)).toBe("1 minute ago");
    expect(ageWords(120)).toBe("2 minutes ago");
    expect(ageWords(59 * 60)).toBe("59 minutes ago");
    expect(ageWords(60 * 60)).toBe("1 hour ago");
    expect(ageWords(65 * 60)).toBe("1 hour 5 minutes ago");
    expect(ageWords(3 * 60 * 60)).toBe("3 hours ago");
  });

  it("never goes negative for a clock that runs ahead", () => {
    expect(ageWords(-30)).toBe("just now");
  });
});

describe("the drive still to go", () => {
  it("is minutes under an hour, hours over it", () => {
    expect(etaWords(1)).toBe("about 1 minute away");
    expect(etaWords(12)).toBe("about 12 minutes away");
    expect(etaWords(60)).toBe("about an hour away");
    expect(etaWords(75)).toBe("about 1 hour 15 minutes away");
    expect(etaWords(120)).toBe("about 2 hours away");
  });
});
