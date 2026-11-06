# HI team feature parity audit - 6 November 2026

HI is the destination product. The earlier NahaLabs assistant app stays live and unchanged until parity and selected-work transfer are proven. This branch does not redirect or delete it, migrate passwords, connect accounts, send mail or activate imported routines.

| Capability | Source truth | Destination | Status |
|---|---|---|---|
| Four named teammates/custom bots | Source app real prompts, local custom-bot storage | Existing HI agents + Team | Built; local real-browser/model proof |
| Group discussion/follow-up with @Name addressing | Private-room turns, browser/account chat state | HI tenant messages + private room | Built; persistence/isolation proof |
| Skills | Source app saved browser task templates | Existing HI registry + Skills UI | Built; create/run/delete tests |
| Routines | Source app queues only while app open | Existing HI tasks/cron; skill restrictions retained | Built; due/parallel-claim/missing-skill tests |
| Vault | Source app displays unavailable; no secure secret vault | HI Documents/Files/Connections + honest notice | Safe notice, not a password vault |
| Chat/account sync | Source app has separate auth and partial state sync | HI existing login and tenant storage | Reused; no second login |
| Selected work | Chats, custom bots, skills in source browser/account | Explicit reviewed JSON import, deduped | Built; legacy format alias kept |
| Browser/research/email/calendar/files | Real but overlapping capabilities | HI existing workflows and approvals | Reuse, not port as duplicate |
| Slide decks (.pptx) | Source app builds real editable decks from a model outline | create_file format=pptx, genuine PPTX download | Built; unit + route tests |
| Answer styles (normal/fast/think/fun) | Source app chat modes | Agent composer mode select, prompt-level styles, facts/approvals unchanged | Built; prompt tests |
| Legal pages | Source app /privacy and /terms | HI /privacy and /terms, linked from the landing footer | Built; route tests |
| Sample image generator | Labelled sample, not a real generator | Do not copy fake functionality | Dropped from destination scope |
| Pages (notes) | Source app extra | HI Files + Memory cover storage; no separate notes screen | Decision recorded |
| Settings/themes | Source app dark/light switch | HI keeps its owner-approved premium design; no theme switch | Decision recorded |

Remaining before any cutover: validate selected export from source UI without secrets; migration limits and rollback; failure/concurrency/load checks; live HI account smoke; pages/deck parity decision. No automatic import from localStorage on another origin is possible. No production claims based on synthetic QA outputs.

Free hosting sleeps and the external scheduler can be late. Routines are persisted, not guaranteed exact-time delivery. Customer outbound effects remain approval-gated. All team discussion is draft-only and cannot execute code or browse; source-backed work uses HI Agent workflows.
