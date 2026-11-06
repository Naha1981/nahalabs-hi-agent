# Selected-work transfer, without shutting down the source

No source app changes are deployed as part of this branch. Source data stays where it is. HI import accepts a reviewed `selected-work-v1` JSON file (older exports with the legacy format key still import) with `bots`, `skills` and `chats` only. It never accepts account tokens, passwords, vault entries, OAuth connections or active routines. Recreate routines explicitly in HI after reviewing skills. Imported custom skills are limited to recall and creating internal files. They do not inherit sends or browser powers.

Before cutover, add a proper selected-export UI to the source under a separate tested change. Browser-only custom bots/skills/routines are not in its server account state, so a backend-only export would miss them. Do not claim migration ready until that UI is tested with source browser data. Current importer tests use synthetic selected exports only. Real customer account transfer has not happened.

Example (synthetic, no credentials):
```json
{"format":"selected-work-v1","bots":[{"name":"Draft helper","job":"Prepare drafts for review"}],"skills":[{"name":"checklist","task":"Write a short checklist from the supplied facts only."}],"chats":[{"title":"Example","messages":[{"role":"user","text":"Draft a checklist"},{"role":"assistant","text":"Example draft only"}]}]}
```
