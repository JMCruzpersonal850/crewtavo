/**
 * The translation layer (src/i18n): plurals, contexts, placeholders, falling back to English,
 * es-US formatting, notifications and errors read by their shape, and the catalog check: every
 * t()/msg()/<T> text in the code has its Spanish line, and every Spanish line is still used.
 */
import { describe, expect, it } from "vitest";
import { catalogProblems } from "../../../scripts/i18n.mjs";
import { addCatalog, english, getLocale, intlLocaleOf, LOCALES, msg, setLocale, t, translator } from "../src/i18n";
import { installSpanish } from "../src/i18n/es";
import { compilePattern, spanishDate, translateError, translateNotice } from "../src/i18n/patterns";

addCatalog("es", {
  "Test: Clock in": "Test: Marcar entrada",
  "Test: Hello {name}": "Test: Hola {name}",
  "Test: {count} visits": { one: "Test: {count} visita", other: "Test: {count} visitas", many: "Test: {count} de visitas" },
  "verb::Test: Open": "Test: Abrir",
  "state::Test: Open": "Test: Abierta",
});

describe("t", () => {
  it("is English as it's written until a language is chosen", () => {
    expect(getLocale()).toBe("en");
    expect(t("Test: Clock in")).toBe("Test: Clock in");
    expect(t("Test: Hello {name}", { name: "Ana" })).toBe("Test: Hello Ana");
    expect(t("Not in any catalog")).toBe("Not in any catalog");
  });

  it("speaks the language set for the app", () => {
    setLocale("es");
    try {
      expect(t("Test: Clock in")).toBe("Test: Marcar entrada");
      expect(t("Test: Hello {name}", { name: "Ana" })).toBe("Test: Hola Ana");
      expect(t.locale).toBe("es");
    } finally {
      setLocale("en");
    }
  });

  it("falls back to the English for a line with no translation", () => {
    const es = translator("es");
    expect(es("Not in any catalog")).toBe("Not in any catalog");
    expect(es("Still English, {who}", { who: "Luis" })).toBe("Still English, Luis");
  });

  it("fills placeholders, numbers too, and leaves one with no value as it is", () => {
    const en = translator("en");
    expect(en("{a} of {b}", { a: 3, b: 10 })).toBe("3 of 10");
    expect(en("Hi {name}", {})).toBe("Hi {name}");
    expect(en("Hi {name}", { name: null })).toBe("Hi ");
  });

  it("tells the same English apart by its context", () => {
    const es = translator("es");
    expect(es("Test: Open", { context: "verb" })).toBe("Test: Abrir");
    expect(es("Test: Open", { context: "state" })).toBe("Test: Abierta");
    // msg() keeps the context with the text, for a constant translated where it's shown.
    const label = msg("Test: Open", "state");
    expect(es(label)).toBe("Test: Abierta");
    expect(translator("en")(label)).toBe("Test: Open");
    expect(english(label)).toBe("Test: Open");
    expect(msg("Schedule")).toBe("Schedule");
  });

  it("takes a translator per person, whatever the app's language", () => {
    expect(translator("es")("Test: Clock in")).toBe("Test: Marcar entrada");
    expect(translator(null)("Test: Clock in")).toBe("Test: Clock in");
    expect(translator("fr")("Test: Clock in")).toBe("Test: Clock in");
    expect(translator("es").locale).toBe("es");
  });
});

describe("t.plural", () => {
  const forms = { one: "Test: {count} visit", other: "Test: {count} visits" };

  it("picks English's one and other", () => {
    const en = translator("en");
    expect(en.plural(1, forms)).toBe("Test: 1 visit");
    expect(en.plural(0, forms)).toBe("Test: 0 visits");
    expect(en.plural(2, forms)).toBe("Test: 2 visits");
  });

  it("picks Spanish's forms, with many for millions and other when many is missing", () => {
    const es = translator("es");
    expect(es.plural(1, forms)).toBe("Test: 1 visita");
    expect(es.plural(0, forms)).toBe("Test: 0 visitas");
    expect(es.plural(5, forms)).toBe("Test: 5 visitas");
    expect(es.plural(1_000_000, forms)).toBe("Test: 1000000 de visitas");
    addCatalog("es", { "Test: {count} hours": { one: "Test: {count} hora", other: "Test: {count} horas" } });
    expect(es.plural(1_000_000, { one: "Test: {count} hour", other: "Test: {count} hours" })).toBe("Test: 1000000 horas");
  });

  it("falls back to English when there's no Spanish, and takes other placeholders", () => {
    const es = translator("es");
    expect(es.plural(3, { one: "{count} photo of {who}", other: "{count} photos of {who}" }, { who: "Ana" })).toBe("3 photos of Ana");
  });
});

describe("formatting", () => {
  it("is es-US for Spanish: US numbers and money, Spanish words", () => {
    expect(LOCALES).toEqual(["en", "es"]);
    expect(intlLocaleOf("en")).toBe("en-US");
    expect(intlLocaleOf("es")).toBe("es-US");
    const money = (tag: string) => new Intl.NumberFormat(tag, { style: "currency", currency: "USD" }).format(1234.5);
    expect(money(intlLocaleOf("en"))).toBe("$1,234.50");
    expect(money(intlLocaleOf("es"))).toBe("$1,234.50");
    const day = new Date("2026-10-15T12:00:00Z");
    expect(day.toLocaleDateString(intlLocaleOf("en"), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })).toBe("Thu, Oct 15");
    expect(day.toLocaleDateString(intlLocaleOf("es"), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })).toBe("jue, 15 de oct");
    expect(day.toLocaleTimeString(intlLocaleOf("es"), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).replace(/\s/g, " ")).toBe("12:00 p.m.");
  });
});

describe("text written in English, read by its shape", () => {
  installSpanish();

  it("turns the database's English dates into Spanish ones", () => {
    expect(spanishDate("Thu Oct 15, 9:00 AM")).toBe("jue, 15 de oct, 9:00 a.m.");
    expect(spanishDate("Thu Oct 15")).toBe("jue, 15 de oct");
    expect(spanishDate("Mon, Sep 7 at 12:30 PM")).toBe("lun, 7 de sept, 12:30 p.m.");
    expect(spanishDate("Oct 15, 2026")).toBe("15 de oct de 2026");
    expect(spanishDate("Oct 5")).toBe("5 de oct");
    expect(spanishDate("6:00 PM Thu")).toBe("6:00 p.m. del jueves");
    expect(spanishDate("7:05 AM")).toBe("7:05 a.m.");
    expect(spanishDate("Mow the lawn")).toBeNull();
  });

  it("reads a pattern's captures lazily, anchored at both ends", () => {
    const re = compilePattern("{title} moved to {when} (was {was})");
    expect("Mow moved to Thu Oct 15 (was Wed Oct 14)".match(re)?.groups).toEqual({ title: "Mow", when: "Thu Oct 15", was: "Wed Oct 14" });
    expect(re.test("Mow moved to Thu Oct 15")).toBe(false);
  });

  it("leaves English readers' notices and errors as they are", () => {
    const notice = { title: "Your clock is still running", body: "Started at 7:00 AM, 11 hours ago. Stop it if the day is done." };
    expect(translateNotice("en", notice)).toBe(notice);
    expect(translateNotice(null, notice)).toBe(notice);
    expect(translateError("en", "Something went wrong.")).toBe("Something went wrong.");
  });

  it("leaves what it doesn't know in English", () => {
    expect(translateNotice("es", { title: "Something no table knows", body: null })).toEqual({ title: "Something no table knows", body: null });
    expect(translateError("es", "A message no table knows")).toBe("A message no table knows");
  });
});

describe("the Spanish catalog", () => {
  it("has a line for every text the code translates, and nothing left over", () => {
    expect(catalogProblems()).toEqual([]);
  }, 60_000);
});
