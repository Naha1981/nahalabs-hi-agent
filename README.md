# HI by NahaLabs - Opportunity Desk + AI employee

HI is NahaLabs' multi-tenant AI employee platform. The Opportunity Desk module finds South African public-sector tenders that fit a business, shows why each one matched, tracks compliance documents and sends a brief only after the customer approves it. Drive Companion (voice) is being added on top of the same agent, approvals and audit trail.

## What it does today
- Persistent named agents with memory, conversations, scheduled tasks, and a multi-step planner with specialist skills (research, tender analysis, writing; customers can add their own).
- Reads National Treasury eTenders OCDS open data (licence: Open Data Commons PDDL 1.0). Deterministic, explainable scoring; every item links to its official source and bid documents.
- Customer-connected Gmail/Outlook/Calendar over OAuth: the agent can search mail, list upcoming events, and draft emails and events. Sends and creates execute only after approval in the queue.
- Controlled browser jobs on isolated GitHub Actions runners: read or click through public sites; passwords/cards/codes refused, risky clicks wait for approval, one-job tokens, same-site only.
- Phone bridge (opt-in): the agent can propose tasks for a paired Android phone - open apps, read the screen, tap and type. Every task waits in the approval queue; the bridge app on the customer's own machine runs only approved tasks and reports back.
- WhatsApp connector (engine-agnostic): unknown senders are ignored; owner access requires one-time number verification; generated replies are queued for owner approval before sending; caps and the emergency stop remain in force.
- Voice turns (Drive Companion slice 1): the Drive page records speech, transcribes it (Groq Whisper), runs it through the shared agent with a hands-free driving policy, and speaks the answer (Groq Orpheus TTS with browser-speech fallback). Approvals stay in the queue.
- Agent file generation (csv, md, txt, HTML and genuine xlsx workbooks) with downloads and API reads.
- Sandton Growth Engine: tenant-scoped, source-linked agency/agent prospects, property listings, mandate evidence, campaign authorisation states, outreach opt-outs and evidence-tagged metrics; CSV exports are saved in Files.
- Approval queue, per-account pause, global emergency stop, append-only audit log, morning brief (approval-gated, per-tenant auto-send opt-in), public /v1 API with tenant keys.

## What it does not do
No bid submission, no payments, no unofficial WhatsApp techniques, no reading of sensitive content aloud by default. Outbound email from the platform mailbox goes only to the signed-in account's own address, after approval, under a daily cap.

## Safety design
- Tenant isolation is enforced in Postgres with row-level security (FORCE RLS). The app connects as `hi_app` (no BYPASSRLS, not table owner). Every tenant query runs in a transaction that sets `app.tenant_id`.
- Tender, web, email and page content is untrusted data: escaped on screen, redacted before model calls, never allowed to select tools or actions.
- Every action that leaves the account (email, calendar event, browser task, risky browser click) is a proposal until a signed-in customer approves it. Pause and emergency stop are re-checked at execution time.

## Run locally
```
npm ci
npm test            # starts an embedded Postgres, runs isolation, flow, agent, browser, whatsapp, api, integrations and voice tests
```
Migrations: `MIGRATE_DATABASE_URL=... HI_APP_PASSWORD=... npm run migrate`.

## Scheduler
An external cron service calls `POST /internal/run?job=ingest|match|brief|tasks|morning-brief|viewing-reminders|doc-reminders|all` with header `x-cron-secret: $CRON_SECRET`. `all` runs every job in sequence, so one periodic `all` call covers ingest, matching, briefs, scheduled tasks, the morning brief and reminders. Each run stamps `system_flags.last_cron_run`, shown on the Settings page, so a silent cron failure is visible. `POST /internal/stop?on=true|false` toggles the emergency stop.

## Environment
Every variable the code reads is documented in `.env.example`, with where to get it and what it costs. Everything on the default path is free tier or open source.

The Sandton operator is research-and-draft-first. Records start unverified, all property-specific campaigns remain awaiting authorisation, performance data remains unverified, and the tools never publish posts or send prospecting messages. Real photo/video production needs media supplied or authorised by the listing agent and a free tool with lawful commercial rights. This branch does not implement an image/video generator.

## Free-tier limits
Render free web services sleep after 15 minutes idle. Supabase free pauses after a week of low activity. Resend free allows 100 emails a day. Groq free tier caps tokens and audio seconds per day. See the Drive Companion blueprint in Notion for the Oracle Cloud deployment direction.

(c) NahaLabs (Pty) Ltd. All rights reserved.
