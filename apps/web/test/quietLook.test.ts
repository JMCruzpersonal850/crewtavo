/**
 * The quiet look (direction B) where it's easy to get wrong: a status is colored words only when
 * someone has to act, the quiet grey and the red words still read on every fill they sit on in both
 * themes, a check box's edge is 3:1, and the shared lists, toggles, dialogs and phone headers keep
 * the shape the mockups give them (styles/components.css).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntityStatus } from "../src/components/ui/StatusPill";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const tokens = read("styles/tokens.css");
const css = read("styles/components.css");

type Rgb = [number, number, number];
const hex = (value: string): Rgb => [0, 2, 4].map((i) => parseInt(value.replace("#", "").slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const require = createRequire(import.meta.url);
const radix = ["sand", "red"].map((scale) => readFileSync(require.resolve(`@radix-ui/colors/${scale}-dark.css`), "utf8")).join("\n");
const light = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root.dark {"));
const dark = tokens.slice(tokens.indexOf(":root.dark {"));
function token(theme: "light" | "dark", name: string): Rgb {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(theme === "light" ? light : dark)?.[1]?.trim();
  if (!value) throw new Error(`No --${name} in the ${theme} theme`);
  const step = /^var\(--([a-z]+-\d+)\)$/.exec(value)?.[1];
  return hex(step ? new RegExp(`--${step}:\\s*(#[0-9a-fA-F]{6});`).exec(radix)![1]! : value);
}

describe("a record's status", () => {
  const tone = (kind: Parameters<typeof EntityStatus>[0]["kind"], status: string) => /data-tone="([a-z]+)"/.exec(renderToStaticMarkup(createElement(EntityStatus, { kind, status })))![1];

  it("is colored words only for a state someone has to act on", () => {
    expect(tone("request", "new")).toBe("warning");
    expect(tone("quote", "changes_requested")).toBe("warning");
    expect(tone("job", "requires_invoicing")).toBe("warning");
    expect(tone("invoice", "overdue")).toBe("danger");
  });

  it("is an amber dot and plain words for one on its way (a lead, partly paid), and plain for a lost quote", () => {
    expect(tone("client", "lead")).toBe("pending");
    expect(tone("invoice", "partially_paid")).toBe("pending");
    expect(tone("referral", "new")).toBe("pending");
    expect(tone("credit", "earned")).toBe("pending");
    expect(tone("quote", "lost")).toBe("muted");
    const pending = css.split("\n").find((line) => line.startsWith('.pill[data-tone="pending"] {'))!;
    expect(pending).toContain("--tone: var(--req)");
    expect(pending).not.toContain("color:");
  });
});

describe("the quiet grey and the red words", () => {
  it("read at 4.5:1 on every fill they sit on (sidebar, tracks, hovered and highlighted rows)", () => {
    for (const surface of ["page", "ground", "fill-2", "seg-track", "ground-hover", "fill-3", "menu", "menu-hi"]) {
      expect(contrast(token("light", "quiet"), token("light", surface)), `light --quiet on --${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ["page", "ground", "seg-track", "fill-2", "ground-hover", "menu", "menu-hi"]) {
      expect(contrast(token("dark", "quiet"), token("dark", surface)), `dark --quiet on --${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("dark", "danger"), token("dark", surface)), `dark --danger on --${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("frame a check box at 3:1, where a hairline would be 1.6:1", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const surface of ["page", "surface", "fill", "menu"]) {
        expect(contrast(token(theme, "check-edge"), token(theme, surface)), `${theme} --check-edge on --${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(css).toMatch(/:where\(input\[type="checkbox"\]:not\(\.switch, \[role="switch"\]\)\) \{[^}]*appearance: none;[^}]*border: 1px solid var\(--check-edge\)/);
  });
});

describe("the shared pieces", () => {
  it("stack a phone's list rows on one line each, not a line under every cell of the last one", () => {
    expect(css).toContain(".card:has(> :is(.table, .table-scroll)) .table-stack tbody tr:last-child td { border-bottom: 0; }");
  });

  it("keep a list's filters on one row that scrolls, rather than wrapping into a block", () => {
    expect(css).toMatch(/\n\.tabs \{ flex-wrap: nowrap; overflow-x: auto;/);
    expect(css).toContain('.tabs[data-more="right"]');
    expect(css).toContain(".toolbar .tabs { flex: 0 1 auto; min-width: 0; }");
  });

  it("draw a toggle with no track under it as a filled chip, solid once it's on", () => {
    expect(css).toMatch(/:not\(\.tabs, \.segmented\) > \.tab \{[^}]*background: var\(--fill-2\)/);
    expect(css).toMatch(/:not\(\.tabs, \.segmented\) > \.tab:is\(\[aria-pressed="true"\], \[aria-selected="true"\]\) \{[^}]*background: var\(--solid\)/);
  });

  it("keep a dialog's buttons inside it when they come straight after its body, with no ring round the whole dialog", () => {
    expect(css).toContain(".dialog-content > .form-actions { display: flex; flex: none; margin: 0; bottom: 0; overflow: visible; }");
    expect(css).toContain(".dialog:focus-visible { outline: none; }");
  });

  it("float a phone page's one primary over the list above the tab bar, with room left under the list for it", () => {
    expect(css).toMatch(/\.page-header > \.page-actions:not\(:has\(> \.btn-primary ~ \.btn-primary\)\) > \.btn-primary \{ position: fixed;[^}]*bottom: calc\(var\(--mobile-nav-height\) \+ 16px/);
    expect(css).toMatch(/\.content:has\([^{]*\.btn-primary\) \{ padding-bottom: calc\(var\(--mobile-nav-height\) \+ 92px/);
    expect(css).toMatch(/\.fab \{[^}]*height: 52px;[^}]*border-radius: var\(--radius-pill\); background: var\(--green-solid\)/);
  });

  it("keep the photo editor's buttons light on its dark bar in the light theme", () => {
    expect(css).toContain(".photo-editor .btn:not(.btn-primary, .btn-danger-solid) { border-color: rgba(255, 255, 255, 0.28); color: #f2f2f2; }");
  });
});
