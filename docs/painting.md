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

> **Prices.** Phase 2 (below) replaced the preset's starter prices with the blueprint's
> derived costs wherever Lead Control supports them. A few services still carry flagged
> starter prices — cabinets, shutters, pressure washing, wallpaper removal, trip charge —
> because no Ocean Crest proposal prices them; they are marked in the preset's commit and in
> the phase 2 notes, and each company's own price list is theirs to correct.

## Locked decisions (Josue, 2026-11-26)

1. Painting lives **only** in painting-preset companies — preset gating, never an installable
   app. (If upstream ever wants an app, the gate can move to a settings flag mechanically.)
2. **One price book** with Interior / Exterior categories.
3. Gallons **round up per room** (Phase 3 math).
4. The Client Hub shows **per-room scope, money only as package totals** (Phase 3).
5. Sub pay stays **office-only** (Phase 4 wiring only).

## Phase 2 — the real numbers (shipped on the fork)

Everything below is gated exactly like phase 1: painting companies only, additive tables,
and the shared totals math untouched (the builder still writes ordinary quote line items).

- **The numbers** live per company at `companies.settings.painting` (core
  `paintSettingsFrom`): subcontractor rates $2.00/sq ft interior and $5.00/unit exterior,
  labor $80/hr, material markup 30%, default margin 30% (price = cost ÷ (1 − margin)),
  overhead 15%, warranty reserve 2.5% — Lead Control's proposal settings, verbatim. Read and
  written at `GET`/`PUT /api/painting/settings`; Settings → Painting edits them.
  *Assumption, flagged:* the blueprint doesn't say what base Lead Control charges overhead
  and the reserve on; Crewtavo charges both on direct cost, before the margin.
- **Products** (`paint_products`): name, brand, interior/exterior/trim, cost per gallon,
  markup %, coverage per gallon — seeded from the blueprint (Interior Acrylic Latex $42 @
  400, Exterior Acrylic Latex $48 @ 320, ProClassic Trim $55 @ 350 lin ft, Duration Exterior
  $48 @ 350). CRUD at `/api/painting/products`; Settings → Painting edits them.
- **Packages** (`paint_packages`): Ocean Crest's actual Lead Control proposal templates —
  all four sets (Interior Standard/Premium/Ultimate, Interior (Standard Package), Exterior,
  Exterior (Good)), twelve tiers with their real products, coats, markups (Good 0–5%,
  Better 0–15%, Best 25–30%) and warranties (12–60 months), seeded by
  `POST /api/painting/setup` and edited in Settings → Painting. Products Lead Control names
  but never priced (SuperPaint, Duration Interior, Emerald, Resilience, Emerald Rain
  Refresh) stay client-facing names; only Duration Exterior links to a costed product.
  `POST /api/painting/:id/packages` offers picked packages on a proposal: each becomes a
  `quote_options` row (new nullable `paint_package_id` beside roofing's `package_id`), the
  proposal's own lines become the default package's option, and the other packages get
  copies repriced by the painting math with their product and coats, plus their markup —
  so the Hub's pick-and-sign works unchanged, and an exterior package's surfaces (stucco,
  trim, door trim as an optional add-on line) ride inside it as ordinary lines.
- **The math** (core `paintProposalMath`, pure and tested): per surface — sub cost at the
  scope's sub rate (flat-fee lines carry their fee; labor-hour lines price at the labor
  rate), gallons = quantity × coats ÷ coverage **rounded up per room per product** (rooms
  keyed by name; phase 3's builder supplies real rooms, until then each line is its own
  room), material at cost × (1 + markup) on the rounded gallons, shared back over the
  surfaces that drank from the pot; then overhead and the warranty reserve on direct cost,
  and the price set by the margin. The proposal page shows all of it (Painting math panel)
  with an adjustable margin and profit in $ and %, and can write the prices onto the lines.

## Roadmap

- **Phase 3 — the proposal engine**: room-by-room builder (measurements → sq ft → gallons
  per room, rounded up per room) writing ordinary quote line items; the Hub shows rooms and
  scope, prices only as package totals.
- **Phase 4 — subs and profit**: proposal material costs carried into job costs, sub price
  prompt on painting jobs, profit views; sub pay remains office-only.
