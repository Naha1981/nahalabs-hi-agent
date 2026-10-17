# HI Opportunity Desk (NahaLabs)

HI finds South African public-sector tenders that fit a business, shows why each one matched, tracks compliance documents and sends a brief only after the customer approves it.

## What v1 does
- Reads National Treasury eTenders OCDS open data (licence: Open Data Commons PDDL 1.0).
- Per-customer profile (keywords, exclusions, categories, favoured buyers). Deterministic, explainable scoring. Every item links to its official source and bid documents.
- Document tracker with expiry alerts (details only; files are not stored in v1).
- Approval queue: the agent proposes, a signed-in customer user decides. Nothing is emailed without approval.
- Memory: dismissals and outcomes are stored per customer and change later scores.
- Scheduled work: ingest, match and brief jobs triggered by an authenticated endpoint.
- Audit log (append-only), per-account pause and a global emergency stop.

## What it does not do
No bid submission, no browser automation, no WhatsApp (needs paid message templates), no file storage, no multi-agent delegation. These are later phases.

## Safety design
- Tenant isolation is enforced in Postgres with row-level security (FORCE RLS). The app connects as `hi_app` (no BYPASSRLS, not table owner).
- Every tenant query runs in a transaction that sets `app.tenant_id`.
- Tender text is untrusted data. It is escaped on screen, redacted before any model call, and model output is plain text only; it never selects tools or actions.
- Outbound email goes only to the signed-in account's own address, after approval, under a daily cap.

## Run locally
```
npm ci
npm test            # starts an embedded Postgres, runs isolation and flow tests
```
Migrations: `MIGRATE_DATABASE_URL=... HI_APP_PASSWORD=... npm run migrate`.

## Scheduler
`POST /internal/run?job=ingest|match|brief|all` with header `x-cron-secret: $CRON_SECRET`. `POST /internal/stop?on=true|false` toggles the emergency stop.

## Free-tier limits
Render free web services sleep after 15 minutes idle. Supabase free pauses after a week of low activity. Resend free allows 100 emails a day. See the NahaLabs HQ blueprint for the paid step.

(c) NahaLabs (Pty) Ltd. All rights reserved.
