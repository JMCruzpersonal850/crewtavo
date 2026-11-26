# Painting

Painting is a trade, not an app. A business that picks **Painting** at signup (or switches to it
in Settings → Company) gets the painting pack; every other trade sees none of it — no painting
screens, no painting words, no changed code paths. The gate is one check,
`isPaintingTrade(company.trade_preset)` in `packages/core/src/painting.ts`, and every
painting-only surface goes through it.

## What Phase 1 ships

- **The preset** (`packages/core/src/presets/painting.json`, registered in `PRESETS` like every
  trade): services in one price book under **Interior / Exterior / Prep and repairs**
  categories, priced by the surface (walls and ceilings per sq ft, trim and baseboards per
  linear ft, window trim, tray ceilings, doors and cabinets each); "Paint job — interior" and
  "Paint job — exterior" checklists in working order (walkthrough and colors → masking →
  prep → prime → coat 1 → coat 2 → touch-ups → final walkthrough with signature → photos) and
  a separate **lead-safe (pre-1978)** checklist; the **color & sheen sheet** as custom fields
  on quotes and jobs (paint color, sheen, product/brand, built before 1978) so values carry
  from the proposal to the job; a "Painting estimate request" intake form; exterior weather
  rules (rain, 24 dry hours, 50 °F minimum, humidity — the additive optional
  `max_humidity_pct` on `WeatherRule`); SOP categories.
  Signup seeds all of it through the same `applyPreset()` as every trade, and Settings →
  Company can switch an existing company to the painting preset with no new machinery.
- **The word**: for a painting company the document is a **Proposal**, everywhere else a
  Quote. `docWord()` (core) drives the nav item, the Create menu, the quotes list and quote
  page titles and the printed document's heading word; the Client Hub gets the word itself
  from the server (`doc_word`) — the trade is never sent to clients. Labels only — tables,
  routes and URLs stay `quotes`.
- **Back-fill**: `POST /api/painting/services` (admins, Settings permission) adds the painting
  services and fields a company is missing, for a company that switched its trade after
  signup. It refuses any company whose trade isn't painting (403) before touching anything.

> **Placeholder prices.** Every price in the preset is a starter value in the owner's style
> (interior walls $2.50/sq ft and the like), **not** his real Lead Control rates. Phase 2
> replaces them with the real production rates and product numbers. Do not quote a real job
> off the seeded prices until then.

## Locked decisions (Josue, 2026-11-26)

1. Painting lives **only** in painting-preset companies — preset gating, never an installable
   app. (If upstream ever wants an app, the gate can move to a settings flag mechanically.)
2. **One price book** with Interior / Exterior categories.
3. Gallons **round up per room** (Phase 3 math).
4. The Client Hub shows **per-room scope, money only as package totals** (Phase 3).
5. Sub pay stays **office-only** (Phase 4 wiring only).

## Roadmap

- **Phase 2 — real numbers**: `paint_products` (cost/gal, markup %, coverage sq ft/gal) and a
  Settings → Painting page; the preset's placeholder prices replaced with Josue's actual
  Lead Control production rates and products.
- **Phase 3 — the proposal engine**: room-by-room builder (measurements → sq ft → gallons
  per room, rounded up per room) writing ordinary quote line items; `paint_packages`
  (Good / Better / Best) feeding the existing quote options and Hub pick-and-sign; the Hub
  shows rooms and scope, prices only as package totals.
- **Phase 4 — subs and profit**: proposal material costs carried into job costs, sub price
  prompt on painting jobs, profit views; sub pay remains office-only.
