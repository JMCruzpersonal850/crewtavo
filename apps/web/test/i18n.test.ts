/**
 * The app in Spanish (lib/i18n.tsx): sentences with links translated whole (<T>), dates, times and
 * money formatted es-US for whoever chose Spanish and en-US for everyone else, and the screens a
 * crew uses kept free of English typed outside t() (scripts/i18n.mjs COVERED; `node scripts/i18n.mjs
 * report` lists what's left anywhere).
 */
import { addCatalog, setLocale } from "@crewtavo/core/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { COVERED, listFiles, rawStrings } from "../../../scripts/i18n.mjs";
import { formatDate, formatDateTime, formatDay, formatMoney, formatMoneyCents, formatNumber, formatTime, timeAgo, weekdayName } from "../src/lib/format";
import { T } from "../src/lib/i18n";

addCatalog("es", {
  "Test: Read the <link>terms</link> before {date}": "Test: Lee los <link>términos</link> antes del {date}",
});

afterEach(() => setLocale("en"));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replace(/<!-- -->/g, "");

describe("<T>", () => {
  const sentence = () =>
    createElement(T, { text: "Test: Read the <link>terms</link> before {date}", link: (s: unknown) => createElement("a", { href: "/license" }, s as string), date: createElement("b", null, "Oct 15") });

  it("draws links and values inside the English sentence", () => {
    expect(html(sentence())).toBe('Test: Read the <a href="/license">terms</a> before <b>Oct 15</b>');
  });

  it("draws them inside the Spanish sentence, wherever Spanish puts them", () => {
    setLocale("es");
    expect(html(sentence())).toBe('Test: Lee los <a href="/license">términos</a> antes del <b>Oct 15</b>');
  });
});

describe("formatting", () => {
  const when = "2026-10-15T16:20:00Z";

  it("stays en-US for everyone who didn't choose Spanish", () => {
    expect(formatMoney(1234)).toBe("$1,234");
    expect(formatMoneyCents(1234.5)).toBe("$1,234.50");
    expect(formatDay("2026-10-15T12:00:00")).toBe("Thu, Oct 15");
    expect(formatDate("2026-10-15")).toBe("Oct 15, 2026");
    expect(formatTime(when, "America/Chicago").replace(/\s/g, " ")).toBe("11:20 AM");
    expect(formatDateTime(when, "America/Chicago").replace(/\s/g, " ")).toBe("Thu, Oct 15, 11:20 AM");
    expect(formatNumber(1234.5, 1)).toBe("1,234.5");
    expect(timeAgo(new Date())).toBe("just now");
    expect(weekdayName(4)).toBe("Thursday");
  });

  it("is es-US in Spanish: US money and numbers, Spanish days and times", () => {
    setLocale("es");
    expect(formatMoney(1234)).toBe("$1,234");
    expect(formatMoneyCents(1234.5)).toBe("$1,234.50");
    expect(formatDay("2026-10-15T12:00:00")).toBe("jue, 15 de oct");
    expect(formatDate("2026-10-15")).toBe("15 oct 2026");
    expect(formatTime(when, "America/Chicago").replace(/\s/g, " ")).toBe("11:20 a.m.");
    expect(formatNumber(1234.5, 1)).toBe("1,234.5");
    expect(weekdayName(4)).toBe("jueves");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000))).toBe("anteayer");
  });
});

describe("the screens a crew uses", () => {
  it("have no English typed outside t()", () => {
    const left = listFiles(COVERED).flatMap((file) => rawStrings(file).map((s) => `${file}:${s.line} [${s.kind}] ${s.text}`));
    expect(left).toEqual([]);
  }, 60_000);
});
