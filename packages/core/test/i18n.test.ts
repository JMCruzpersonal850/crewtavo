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

describe("notifications to the team, in Spanish", () => {
  installSpanish();
  const es = (title: string, body: string | null = null) => translateNotice("es", { title, body });

  it("reads the schedule changes the database writes, one line at a time", () => {
    expect(es("You're on Smith mowing: Thu Nov 12, 7:00 AM").title).toBe("Te pusieron en Smith mowing: jue, 12 de nov, 7:00 a.m.");
    expect(es("You're off Smith mowing (Thu Nov 12)").title).toBe("Te quitaron de Smith mowing (jue, 12 de nov)");
    expect(es("Hedges on Fri Nov 13, 9:30 AM was cancelled").title).toBe("Se canceló Hedges del vie, 13 de nov, 9:30 a.m.");
    expect(es("Hedges moved to Mon Nov 16 (was Fri Nov 13)").title).toBe("Hedges se movió al lun, 16 de nov (era el vie, 13 de nov)");
    expect(es("Hedges now starts Fri Nov 13, 10:00 AM").title).toBe("Hedges ahora empieza el vie, 13 de nov, 10:00 a.m.");
    expect(es("3 changes to your schedule", "You're on A: Thu Nov 12\nB on Fri Nov 13 was cancelled\nSomething new").body).toBe(
      "Te pusieron en A: jue, 12 de nov\nSe canceló B del vie, 13 de nov\nSomething new",
    );
  });

  it("reads the clock's reminders and the stop it made", () => {
    expect(es("Your clock was stopped for you", "It started at 7:05 AM and was still running, so it was stopped at 6:00 PM Thu. Fix the end time on Timesheets if that's wrong.")).toEqual({
      title: "Tu reloj se paró solo",
      body: "Empezó a las 7:05 a.m. y seguía corriendo, así que se paró a las 6:00 p.m. del jueves. Corrige la hora de salida en Hojas de horas si no está bien.",
    });
    expect(es("Rosa Ruiz's clock is still running", "Started at 6:00 AM, 11 hours ago. Stop it if the day is done.")).toEqual({
      title: "El reloj de Rosa Ruiz sigue corriendo",
      body: "Empezó a las 6:00 a.m., hace 11 horas. Páralo si ya terminó el día.",
    });
  });

  it("reads chat mentions, a sub's offers and pay, and their paperwork", () => {
    expect(es("Ana Ortiz mentioned you in #crew", "Sent a photo")).toEqual({ title: "Ana Ortiz te mencionó en #crew", body: "Envió una foto" });
    expect(es("Smith roof, Tue Nov 3 to Thu Nov 5, 24 squares, $2,040. Answer by Mon Nov 2, 5:00 PM. Open Crewtavo to accept or decline.", "New job offer.")).toEqual({
      title: "Smith roof, mar 3 de nov a jue 5 de nov, 24 cuadros, $2,040. Responde antes del lun, 2 de nov, 5:00 p.m. Abre Crewtavo para aceptar o rechazar.",
      body: "Nueva oferta de trabajo.",
    });
    expect(es("Paid $1,200 on Nov 10", "Smith roof, by check.")).toEqual({ title: "Pagado $1,200 el 10 de nov", body: "Smith roof, con cheque." });
    expect(es("Your liability insurance ends in 12 days", "It ends Nov 25, 2026. Send us the new one under My paperwork.")).toEqual({
      title: "Tu seguro de responsabilidad civil vence en 12 días",
      body: "Vence el 25 de nov de 2026. Envíanos el nuevo en Mis documentos.",
    });
  });

  it("reads a machine coming due, and a client asking to move a visit", () => {
    expect(es("Oil change is coming due on Truck 2", "Due Nov 20 or at 5,000 miles (now 4,820)")).toEqual({
      title: "Oil change ya casi toca en Truck 2",
      body: "Toca el 20 de nov o al llegar a 5,000 millas (ahora 4,820)",
    });
    expect(es("Ann Lee asked to move Hedges", "Booked Fri Nov 13, 9:30 AM. Asked for Mon Nov 16.").body).toBe("Programada el vie, 13 de nov, 9:30 a.m. Pidió el lun, 16 de nov.");
  });

  it("reads the errors a crew member can meet", () => {
    expect(translateError("es", "You can change a visit's status and notes. Ask the office about anything else.")).toBe("Puedes cambiar el estado y las notas de una visita. Pregúntale a la oficina por lo demás.");
    expect(translateError("es", "Your workers' comp certificate on file has run out.")).toBe("Tu certificado de compensación laboral que tenemos venció.");
    expect(translateError("es", "The lines and tax come to $86.40, not the $90.00 total. Check them.")).toBe("Las líneas y el impuesto suman $86.40, no el total de $90.00. Revísalos.");
  });
});

describe("the Spanish catalog", () => {
  it("has a line for every text the code translates, and nothing left over", () => {
    expect(catalogProblems()).toEqual([]);
  }, 60_000);
});
