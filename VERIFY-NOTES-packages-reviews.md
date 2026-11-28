# Verification notes — Parity items 20/21 (branch packages-reviews)

Base: 4 commits, tree clean — 1a06a689 (package seeds + resync), 5aabd541
(review_feedback table + types), eeb9729d (star-gate route + gate page),
00716069 (staff surface in Marketing → Reviews).

## Checks

- [x] (1) Painting tests: seed values (extBest warranty 36; T2 Better + T6
      Better = Emerald Rain Refresh / 24 mo) + resync behavior —
      **12/12 passed** (apps/api, vitest)
- [x] (2) Gate tests: stars routing, feedback row, gate view stops reminders —
      API **13/13 passed** after a real fix (see Findings); web **4/4 passed**
- [x] (3) Regression sweep: reviews, jobs, hub, painting suites — API combined
      384 tests: 382 passed + 2 stale pre-gate expectations in reviews.test.ts
      (asserted the old straight-to-review-page redirect; updated to the gate
      in b91b6510, reviews re-run 94/94). Web: 203/203 across 14 files
      (jobs/jobsList/jobClosing/jobCounts/jobPay, hubLook/hubDocument/
      hubReviews/hubSigning/hubAutopay/hubNoMoney/hubRange, reviewCompare/
      reviewPlaces).
- [x] (4) Typechecks: api + web DONE (see below)

## Findings so far

- Painting test expectations were already updated by the build commit
  (painting.test.ts: extBest warranty_months 36 / "3-year warranty"; T2 Better
  and T6 Better = Emerald Rain Refresh, 24 mo; resync test re-seeds old rows,
  expects packages_resynced 5, hand-edited row untouched).
- Gate tests were MISSING. Added:
  - apps/api/test/reviewGate.test.ts — tracked link 302 → /r/<token> +
    track_review_click (p_count true; false for link previews), gate facts
    return review_url, feedback POST stores a review_feedback row for 1–3
    stars (second submit deduped), 4/5/0/2.5/"3" stars → 400, unknown token
    → 404.
  - apps/web/test/reviewGate.test.ts — source-pattern checks on
    ReviewGatePage.tsx (>=4 → review_url link, exactly once; 1–3 → feedback
    POST).

## Findings — gate bug (REAL, fixed in 7c6137b0)

First gate-test run: 10/13 — the tracked link answered 200 with an empty body
instead of the 302 to /r/<token>, and the gate's facts answered 500 with an
empty error. Cause: `reviewGateTarget` (routes/public.ts) returned its success
result WITHOUT `ok: true`, while both handlers branch on `gate.ok` — so a valid
link always took the failure branch with undefined status/message (redirect →
c.text(undefined, undefined) = 200 empty; facts → HttpError(undefined) = 500
""). Fix: success return + its type now carry `ok: true`. Re-run: API gate
tests 13/13.

## Results

- API gate tests (test/reviewGate.test.ts): **13/13 passed** (after the fix above)
- Web gate tests (apps/web/test/reviewGate.test.ts): **4/4 passed**
- API sweep (reviews, googleReviews, reviewCard, reviewCompare, hub, jobPay,
  painting): 382/384 on first run — the 2 failures were the stale reviews.test.ts
  expectations above, NOT product bugs; after b91b6510 reviews.test.ts is 94/94,
  so the sweep stands at 384/384.
- Web sweep (jobs + hub + reviews suites, 14 files): **203/203 passed**
- API typecheck (apps/api, npx tsc --noEmit): **PASSED** — exit 0, no errors (run 2026-11-27, ~155s).
- Web typecheck (apps/web, npx tsc --noEmit): first run 45 errors — 6 were
  OURS (ReviewGatePage.tsx TS18048 'data' possibly undefined ×6), fixed in
  1aff1875 by adding a `!data` Broken branch so later branches narrow.
  Re-run after the fix: **39 errors, all pre-existing on the base branch** —
  every one sits in files this branch never touched (ui/ContextMenu 9,
  ui/Select 7, ui/NumberInput 6, ui/Toaster 4, ui/ClientPreview 4,
  ui/Combobox 3, roofing EstimateList 2, ui/Tooltips 2, ui/CodeField 2);
  those files plus tsconfig and package.json are byte-identical to
  proposal-view (empty git diff), so base produces the identical errors.
  Zero errors in any file this branch added or changed. Web gate tests
  re-run after the fix: 4/4.
- TYPECHECK VERDICT (items 20/21): API clean; web clean for this branch's
  code (39 pre-existing base errors in untouched shared UI files).
