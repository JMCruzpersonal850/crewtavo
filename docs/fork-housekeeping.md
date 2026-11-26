# Fork housekeeping

This repo is a **fork** of Crewtavo (github.com/JMCruzpersonal850/crewtavo, forked from
jviars/crewtavo) carrying this business's own work: the Quo app, Square payments, and the
Painting trade. Two rules keep it safe.

## Deploys come from this fork, and only this fork

`.railway/railway.ts` builds every service from `JMCruzpersonal850/crewtavo`, branch `main`.
Nothing deploys from upstream, and nothing in this repo can pull upstream changes on its own:
there is no sync workflow, no auto-merge, and no version file an upstream release can move.
The Railway **template** auto-update ("template services update when the template does")
applies only to projects deployed *from the template* — a throwaway test project was made
that way and does receive upstream updates; the production projects were built service by
service from this fork and do not. If a production project is ever re-created from the
Railway template, it would start receiving template updates — don't: rebuild it from this
repo instead, the way `.railway/railway.ts` describes.

There is no repo-level switch to flip for this; the protection is the deploy source above.
To verify by hand in the Railway dashboard: open each production service → Settings →
Source — it must say `JMCruzpersonal850/crewtavo`, branch `main`. A service whose source is
a template (or upstream's repo) is the one thing to fix.

## Upstream changes arrive by hand, on a test branch first

When upstream ships something worth having:

1. Fetch upstream into a scratch branch (`upstream-sync`), never straight into `main`.
2. Run the full test suites on that branch; resolve conflicts there — the fork's additions
   (Quo, Square, Painting) are additive and painting-gated, so conflicts should stay in
   shared files' import lists and route registrations.
3. Merge to `main` only when green. `main` is what production deploys, within minutes.

## Service image pins

`.railway/railway.ts` pins the PostgREST image to `postgrest/postgrest:v16.4` (checked in
the Painting phase 2 pass, November 2026 — an earlier note said the file might still read
`v16.4.0`, a tag that doesn't exist; it already reads `v16.4`, so nothing changed). Keep
pins at tags that exist; a pin to a missing tag fails the deploy, not the running service.
