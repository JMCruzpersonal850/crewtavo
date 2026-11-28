# Item 19 verification notes (branch client-docs)

Verifier run started Fri 2026-11-27 (third attempt; two prior verifiers died in restarts).
Base state: 2 commits — 412dce1e branded email shell; d71a24b7 Hub invoice presentation. Tree clean.

## Checks

- [x] (1) API typecheck — attempt 2 **PASSED** (tsc --noEmit exit 0, no errors, ~218 s once load eased)
- [~] (2) Web typecheck — **UNVERIFIED**: 4 attempts, every one killed by a runtime restart before completion (logs empty, zero diagnostics ever produced — no evidence of errors, just no completed run). Needs one run in a calm window
- [x] (3) API sweep — **546/546 passed** across all 10 named files (see Results)
- [x] (4) Caller-wiring audit (renderEmail color:/contact:) — done, see table below
- [x] (5) Fixes + commits — no code fixes needed: nothing in the branch's code failed any completed check. All verifier commits are notes-only

## Results

- (1) API typecheck attempt 1: `npx tsc --noEmit` in apps/api — OOM-killed (exit 137) after ~350 s. VM is shared (1.5 CPU / 6 GB) with several wave crews running installs/tests simultaneously; the same typecheck passed in earlier phases on this machine. Verdict: environment contention, not a code error signal. Retry planned after the lighter checks.
- (1) API typecheck attempt 2: **PASSED** — exit 0, no diagnostics, ~218 s (load had eased to ~8).
- (2) Web typecheck attempts 1-2: `npx tsc --noEmit` in apps/web — both runs died in runtime restarts (~5 min in) before printing anything; saved logs empty. No verdict possible. Load average 19-23 on 1.5 shared CPUs at the time.
- (2) Web typecheck attempts 3-4: same outcome — restart-killed at ~10 min and ~4 min respectively; the in-worktree log was 0 bytes both times (tsc emits nothing until it finishes or errors). **Final state: UNVERIFIED.** The web half's runtime behavior is covered by invoicePresentation.test.ts 7/7 and the Hub API tests; only the whole-project web typecheck remains outstanding.
- (3) API sweep (vitest, per-file): **api.test.ts 95/95 passed** (~26 s) — includes the assertions that no-brand-color email output stays byte-identical to legacy. Remaining files running.
- (3) sweep continued: hub.test.ts 155/155 + painting.test.ts 11/11 (166); reviews.test.ts 94/94 + autopay.test.ts 98/98 + onlineBooking.test.ts 19/19 (211); signing.test.ts 37/37 + sales/visitNotices/invoiceReminders 37 combined (74; stderr mock noise inside passing signing tests only). **Sweep total: 546/546 passed, 0 failed.**
- Supplementary (web): test/invoicePresentation.test.ts **7/7 passed** — the new Hub invoice presentation component's own tests are green.
- (5) Fixes: none needed so far — no test or typecheck failure has pointed at the branch's code; every failure was environment (OOM/restarts).

## Caller wiring (renderEmail color:/contact:)

Audited every renderEmail call site in apps/api/src (fourth attempt). Verdict: **every customer-facing sender passes `color:`** (`brandColor(settings) ?? "#0f2a35"`), so the branded band/buttons/links apply to all customer email. Only two senders pass the dedicated `contact:` line; the rest pass a `footer:` (company name/address or companyFooter) that renders in the same under-card spot — by design, not a gap.

| Sender | color: | contact: | Notes |
|---|---|---|---|
| sales.ts:250 `deliver()` (quote/invoice sent + reminders) | ✅ | — (footer) | single renderEmail site in sales.ts |
| marketingEmail.ts `emailClient()` (review requests, referral, automated campaigns, close-pending) | ✅ | — | |
| autopay.ts:264 (receipts/notices/invites) | ✅ | — (footer) | |
| onlineBooking.ts:231 (booking confirmations) | ✅ | ✅ phone · email | |
| visitChanges.ts:120 (visit scheduled/changed) | ✅ | ✅ phone · email | |
| automations.ts:768 (automation emails) | ✅ | — (footer = companyFooter) | |
| signing.ts:291 (signing emails) | ✅ | — (footer) | |
| routes/messages.ts:55 (office-composed client email) | ✅ | — (footer) | |
| campaigns.ts:148 (campaign sends) | ✅ | — (footer = name · address) | |
| guideShares.ts:129, 369 (guide shares) | ✅ | — | |
| routes/email.ts:150, 191 (test emails) | ✅ | — | test sends mirror the real shell |
| routes/marketing.ts:97 (campaign test send) | ✅ | — (footer) | |

Not wired (deliberate — staff/sub/auth mail keeps the legacy shell): routes/account.ts, routes/recovery.ts, services/signInCodes.ts, services/team.ts, services/subs.ts, services/subAccess.ts, services/delivery.ts, services/address.ts, services/careers.ts, services/websiteForms.ts, routes/apps.ts (staff note). Because these callers pass no `color`, the no-color path must stay byte-identical to legacy — which is what api.test.ts asserts.
