/**
 * An invoice's Client Hub page in Lead Control's shape: the branded head (InvoicePresentation)
 * with its band, status pill and info cards, the company footer instead of "Powered by
 * Crewtavo", and the summary's Balance due as a filled brand banner.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const head = readFileSync(new URL("../src/features/hub/InvoicePresentation.tsx", import.meta.url), "utf8");
const headCss = readFileSync(new URL("../src/features/hub/InvoicePresentation.module.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/features/hub/HubPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/features.css", import.meta.url), "utf8");

describe("an invoice's branded head", () => {
  it("renders the band with the invoice number, the issued date and a status pill", () => {
    expect(head).toContain("Invoice #{inv.number}");
    expect(head).toContain("formatDate(inv.issued_on)");
    expect(head).toContain("styles.pill");
    expect(head).toContain('"Written off"');
    expect(head).toContain('"Paid in full"');
    expect(head).toContain('"Past due"');
    expect(head).toContain('"Open"');
  });

  it("shows the subject as the title, the client under it, and the three info cards", () => {
    expect(head).toContain('inv.subject ?? "Invoice"');
    expect(head).toContain("Billed to");
    expect(head).toContain("Company");
    expect(head).toContain("Balance");
    expect(head).toContain("formatMoneyCents(balance)");
    expect(head).toContain("Due on receipt");
  });

  it("draws its band in the company's brand color through its CSS module", () => {
    expect(headCss).toContain("background: var(--brand)");
    expect(headCss).toContain("color: var(--on-brand)");
    expect(head).toContain('from "./InvoicePresentation.module.css"');
  });
});

describe("the invoice page in HubPage", () => {
  it("renders InvoiceHead inside InvoiceHub, before the intro card", () => {
    const invoiceHub = page.slice(page.indexOf("function InvoiceHub"));
    expect(invoiceHub).toContain("<InvoiceHead data={data} balance={balance} late={Boolean(late)} />");
    expect(invoiceHub.indexOf("<InvoiceHead")).toBeLessThan(invoiceHub.indexOf("hub-intro hub-due"));
    expect(page).toContain('from "./InvoicePresentation"');
  });

  it("no longer repeats the subject, number and client line in the intro card", () => {
    expect(page).not.toContain("Invoice #{inv.number}{inv.client");
  });

  it("marks the layout as an invoice layout and closes invoices with the company's own footer", () => {
    expect(page).toContain('className="hub-layout hub-layout-invoice"');
    expect(page).toContain('(d.kind === "quote" && d.quote.paint) || d.kind === "invoice"');
  });
});

describe("an invoice's summary banner", () => {
  it("fills the Balance due line with the brand color, scoped to the invoice layout", () => {
    expect(css).toContain(".hub-layout-invoice .hub-totals .line.grand { background: var(--brand); color: var(--on-brand);");
    expect(css).toContain(".hub-layout-invoice .hub-totals .line.grand > :first-child { color: inherit; }");
  });
});
