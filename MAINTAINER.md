# Maintainer notes

Technical reference only, not customer-facing wording. Reviewed 6 November 2026. These commands are defined in the source, not newly executed in this documentation pass. Use the repository lockfile and established CI/runtime versions. No release or production migration is authorised by this file.

## Defined commands

```sh
npm run start
npm run test
```

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


Hosting, database and provider quotas must be checked live; historical free-tier notes are not a permanent availability guarantee.

## Configuration and costs

Use current example environment schemas and source reads to determine required configuration. Examples contain placeholders only. Do not print credentials or replace licence/attribution files. Do not activate messages, payments, migrations or publication without the applicable approval. No unlimited free service or permanent quota is promised.
