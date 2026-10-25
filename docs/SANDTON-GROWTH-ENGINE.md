# NahaLabs Sandton Real Estate Growth Engine

## Objective

Build a source-backed pipeline for Sandton estate agencies and property practitioners, then help a small number of authorised agents test a better property-marketing and enquiry-handling workflow. HI is an intelligent-systems operator, not a generic chatbot service.

## Pilot offer

**Free pilot for selected agents; one approved listing per pilot.** Selection favours an active, verifiable listing, an observable marketing opportunity, a lawful public business-contact route, and an agent willing to approve media and copy.

Included draft deliverables:
- Premium portrait property-poster concept using only approved listing facts and agent-supplied/authorised images.
- A 15–30 second vertical-video brief or edit plan. Actual generated/edited video is not provided by this repository without a separate authorised free tool and media asset.
- Three distinct social captions and listing-copy variations.
- Optional virtual-staging brief only if an authorised tool supports truthful, labelled output at no cost.
- A viewing/enquiry hand-off design, lead-tracking sheet, and weekly measurement template.

The agent retains listing, account, media and buyer ownership; nothing publishes without explicit authorisation. No number of enquiries, viewings or sale is guaranteed. No unlimited free service is promised.

## Prioritisation (100 points)

Each component is scored from 0–20 and the total is the sum:
- **Relevance:** clearly serves Sandton or the agreed surrounding area.
- **Active inventory:** source-backed public listings that appear current.
- **Marketing gap:** specific evidence of missing/weak video, visual consistency, copy or enquiry path.
- **Contactability:** publicly displayed business contact details and a lawful route for communication.
- **Pilot fit:** listing quality, permission readiness and realistic production scope.

Scores rank research effort; they do not predict conversion. New records remain **unverified** until human review. Re-check listing availability before producing or distributing property-specific content.

## Market boundary

The core_sandton scope covers Sandton Central, Sandhurst, Morningside and Benmore. The surrounding scope covers Bryanston, Rivonia, Hyde Park, Illovo, Fourways and nearby northern Johannesburg suburbs. Keep these scopes separate in exports and reporting.

## Evidence and mandate controls

Every prospect and listing requires a public HTTPS source. Tracking parameters are removed and repeat listing URLs are deduplicated. Records start unverified. Do not scrape private details or record confidential owner/mandate information. Mark a sole/exclusive mandate **verified** only when the listing source explicitly states it and the wording is recorded; otherwise use **not_stated**. An agent’s single listing advert is not evidence of exclusivity.

## Outreach state model

- **not_contacted:** no message sent.
- **draft_ready:** individually researched message saved for review.
- **awaiting_consent:** lawful channel/permission step recorded; still not sent by HI.
- **contacted, replied, pilot_accepted, pilot_active:** reserved for separately evidenced real events; the model-operated update tool cannot mark these.
- **opted_out:** terminal for agent-tool updates; do not restart outreach.
- **closed:** parked with a recorded reason.

Publicly visible contact information does not, by itself, override South African privacy/direct-marketing law. Obtain appropriate consent or use another lawful basis/channel, preserve opt-outs and seek South African legal advice before scaling outreach. HI never sends prospecting messages from these growth tools.

## Campaign and measurement governance

A campaign linked to a real listing starts at **awaiting_authorisation** with authorisation **pending**; the repository has no social-media publishing integration in this feature. Assets stay drafts until the listing agent approves use of media, facts, identity, channels and final files. Virtual staging must be plainly labelled and may not hide structural defects or be shown as the actual photograph.

Metric rows require a note or HTTPS evidence URL and always store verified=false. Reach, views, enquiries, viewing outcomes and sales must come from actual evidence; distinguish estimates from observed results. Exports are limited to 500 rows and guard against spreadsheet formula injection.

## Cost and current technical limits

- **Budget:** R0. No subscriptions, paid credits, advertising, or paid APIs were added.
- **Data and CSV exports:** available as tenant-isolated database tools and downloadable HI Files.
- **Scheduled jobs:** the repository workflow calls HI’s internal scheduler only after Actions secrets HI_BASE_URL and CRON_SECRET exist. The workflow will skip when they are absent.
- **Migration:** apply db/schema.sql using the privileged MIGRATE_DATABASE_URL before deploying this branch; never put that URL in browser/public client code.
- **Real media production/publishing:** not implemented here. It requires authorised source media and a verified, no-cost tool with commercial rights.
- **Verification:** source URLs are recorded, but this branch cannot certify that an external listing is still active; manually recheck it before campaign use.
