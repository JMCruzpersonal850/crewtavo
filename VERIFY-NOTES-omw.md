# OMW (item 5) verification — branch omw-tracking

Started 2026-11-27. Third verifier attempt. Known before start: CORE typecheck PASSED clean.

## Checks
- [x] (1) api typecheck — PASS (tsc --noEmit exit 0, no errors; run detached after two restart/OOM interruptions)
- [x] (2) web typecheck — PASS (tsc --noEmit exit 0; first attempt OOM-killed under sibling-compiler contention, solo detached rerun passed)
- [x] (3) api tests — PASS: liveTracking + schedule (jobs/visits) + quo + visitNotices = 4 files, 65/65 tests passed, exit 0
- [x] (4) web tests — PASS: trackWords + clientNotifications = 2 files, 12/12 tests passed, exit 0
- [x] (5) fixes — NONE NEEDED: every check passed on the branch as committed; no code changes made by the verifier
- [x] (6) final checklist (a)-(f) — below, all six verified from code + tests

## Results
- (1) api typecheck: PASS (exit 0)
- (2) web typecheck: PASS (exit 0)
- (3) api tests: PASS — liveTracking, schedule, quo, visitNotices: 65/65
- (4) web tests: PASS — trackWords, clientNotifications: 12/12
- (5) fixes: none needed
- CORE typecheck: passed earlier (pre-verification)

## Final checklist — item 5 (on-my-way + live tracking)
- (a) OMW action on job/visit screen: YES — "On my way" is the primary next-step button on FieldVisitPage (sets status en_route) and on FieldTodayPage for scheduled visits.
- (b) Tracking link minted on en-route via existing SMS path: YES — services/automations.ts adds {{tracking_link}} for visit.en_route runs (trackingLink() -> signed "track" link, lib/links.ts); the OMW automation renders/sends it through the existing message path (Quo first, Twilio fallback, as all automation SMS); a KEPT_TRACKING_LINK placeholder is stored in the kept copy.
- (c) Latest-ping store + ping/stop endpoints w/ tech auth: YES — migration 20261124000400 creates public.visit_live_location (one row per visit, upsert on visit_id = latest ping only); POST ping + stop-sharing routes in routes/schedule.ts run under the authenticated session (c.var.userId/companyId) and recordPing checks the person is on the visit; a stopped visit refuses further pings (409).
- (d) Ping loop 10-15s foreground + en-route notice: YES — liveTracking.ts PING_MS = 12,000, immediate first report then setInterval while en route (foreground, page open); new "en_route_sharing" worker notice kind (locationNotice.ts, gated on the company liveTrackingOn setting + acknowledgement), LiveSharingNote/LiveSharingRun shown on the visit and today screens while en_route.
- (e) Public /track/:token page w/ map + ETA + "updated X min ago": YES — publicRoutes GET /track/:token (routes/public.ts) serves the state; web TrackPage.tsx renders a MapLibre/OpenFreeMap map with crew + destination, etaWords ETA, and "Updated {ageWords}." freshness line; trackWords tests cover the wording.
- (f) Token expiry + arrival/manual stop: YES — "track" signed links live 4 hours (LIFETIME_DAYS track = 4/24); TrackState en_route/waiting/arrived/stopped/ended — the page stops showing a place when the visit starts (arrival), completes or is cancelled; manual stop via stopSharing stands until the trip ends.

## Verdict
Item 5 is COMPLETE and verified on branch omw-tracking. Ready for the parent's batched push/PR/merge.
