import { describe, expect, it } from "vitest";
import {
  ADDRESS_ZONE_IN,
  artboard,
  backHtml,
  frontHtml,
  leftOutLine,
  mailable,
  mailingAddress,
  messageProblem,
  POSTCARD_SIZE_INFO,
  postcardMessage,
} from "../src/postcards";

describe("where a postcard goes", () => {
  it("takes a complete US address: a street, a city, a state and a ZIP code", () => {
    expect(mailable({ line1: " 12  Oak St ", city: "Springfield", region: "IL", postal_code: "62701" })).toEqual({
      line1: "12 Oak St", line2: null, city: "Springfield", region: "IL", postal_code: "62701", country: "US",
    });
    expect(mailable({ line1: "12 Oak St", line2: "Apt 2", city: "Springfield", state: "IL", zip: "62701-1234", country: "United States" })).toMatchObject({ line2: "Apt 2", region: "IL", postal_code: "62701-1234" });
  });

  it("calls an address with a part missing no address, and one abroad (or with a postcode that isn't a ZIP) outside the US", () => {
    expect(mailable({ line1: "12 Oak St", city: "Springfield", postal_code: "62701" })).toBe("no_address");
    expect(mailable({ line1: "", city: "Springfield", region: "IL", postal_code: "62701" })).toBe("no_address");
    expect(mailable(null)).toBe("no_address");
    expect(mailable({ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1", country: "CA" })).toBe("outside_us");
    expect(mailable({ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1" })).toBe("outside_us");
  });

  it("uses the billing address when it's complete, else the first property that is, and says why when none is", () => {
    const property = { line1: "9 Elm Rd", city: "Peoria", region: "IL", postal_code: "61602" };
    expect(mailingAddress({ line1: "12 Oak St", city: "Springfield", region: "IL", postal_code: "62701" }, [property])).toMatchObject({ line1: "12 Oak St" });
    expect(mailingAddress({ line1: "12 Oak St" }, [{ line1: "no city" }, property])).toMatchObject({ line1: "9 Elm Rd" });
    expect(mailingAddress({}, [])).toBe("no_address");
    expect(mailingAddress({}, [{ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1", country: "CA" }])).toBe("outside_us");
  });

  it("says who's left out and why, the biggest group first", () => {
    expect(leftOutLine({ archived: 1, opted_out: 3, no_address: 8, outside_us: 0 })).toBe("12 left out: 8 with no complete mailing address, 3 opted out of marketing, 1 archived");
    expect(leftOutLine({ outside_us: 2 })).toBe("2 left out: 2 with an address outside the US");
    expect(leftOutLine({ archived: 0 })).toBeNull();
  });
});

describe("what's printed", () => {
  it("fills in the campaign merge fields on the back", () => {
    const vars = { client: { first_name: "Ann", name: "Ann Oak" }, company: { name: "Sketchy Gutters", phone: "(540) 555-0100" }, link: "https://crew.example.com/book/sketchy/spring" };
    expect(postcardMessage("Hi {{client.first_name}},\r\n\r\nBook at {{link}}\n{{company.name}} {{company.phone}}  ", vars)).toBe(
      "Hi Ann,\n\nBook at https://crew.example.com/book/sketchy/spring\nSketchy Gutters (540) 555-0100",
    );
  });

  it("keeps the message to what fits the size", () => {
    expect(messageProblem("Hi", "4x6")).toMatch(/Write the message/);
    expect(messageProblem("x".repeat(400), "4x6")).toBeNull();
    expect(messageProblem("x".repeat(600), "4x6")).toMatch(/fits about 500 characters/);
    expect(messageProblem("x".repeat(600), "6x9")).toBeNull();
  });

  it("draws each side at the size with its bleed, and the front's picture to the edges", () => {
    expect(artboard("4x6")).toEqual({ width: 6.25, height: 4.25 });
    expect(artboard("6x11")).toEqual({ width: 11.25, height: 6.25 });
    const front = frontHtml("6x9", 'https://crew.example.com/api/public/postcards/abc.jpg?x="1"');
    expect(front).toContain("width:9.25in;height:6.25in");
    expect(front).toContain("center/cover");
    expect(front).toContain("&quot;1&quot;");
  });

  it("escapes what's written, keeps paragraphs, and keeps the message out of the address and postage", () => {
    const html = backHtml({ size: "4x6", message: "Hi <b>Ann</b> & co,\n\nLine one\nline two", returnAddress: { name: "Sketchy & Sons", line: "1 Main St, Springfield, IL, 62701" } });
    expect(html).toContain("<p>Hi &lt;b&gt;Ann&lt;/b&gt; &amp; co,</p><p>Line one<br>line two</p>");
    expect(html).toContain("<strong>Sketchy &amp; Sons</strong>1 Main St, Springfield, IL, 62701");
    expect(html).not.toContain("<script");
    const column = POSTCARD_SIZE_INFO["4x6"].width - ADDRESS_ZONE_IN.width - 0.5;
    expect(html).toContain(".message{position:absolute;left:0.375in;top:0.925in;width:1.9in");
    // The column and its inset end before the right side Lob keeps clear.
    expect(0.375 + column).toBeLessThanOrEqual(artboard("4x6").width - ADDRESS_ZONE_IN.width);
  });
});
