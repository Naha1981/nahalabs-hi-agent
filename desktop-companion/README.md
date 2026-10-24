# HI Desktop Companion (Windows-first)

The companion adds a local desktop execution path to the existing HI SaaS platform. It does not replace HI's agent, planner, skills, API, approval queue, browser worker, or Android bridge.

## Scope and safety

- Recording starts only when the customer runs the `record` command; it stops with **Ctrl+Shift+F12** or after 10 minutes.
- The recorder captures clicks, scrolling, safe navigation keys and a placeholder for text fields. It never sends actual typed text, passwords, clipboard content, page text or screenshots to HI.
- Saved steps use UI Automation control names/IDs where available. If an application does not expose accessible controls, the click can be saved as a window-relative coordinate. Coordinate clicks require an extra local confirmation during replay and may fail if the layout changes.
- The user reviews and names a recording before publishing it as a reusable HI skill.
- Running a skill always creates an HI approval request. A locally running companion claims only tasks whose approval status is approved. Ambiguous controls stop rather than guessed; sensitive fields are handled manually; labels that look consequential require an additional local confirmation.
- Runtime input values are requested in the local terminal and are not sent back to HI. Do not enter passwords, one-time codes, card details or other secrets through a recorded skill.
- Use one companion worker per HI tenant for this initial version. It is Windows-first and depends on the target application's Windows accessibility support; it is not yet a packaged installer or a promise that every custom-drawn application can be replayed automatically.

## Requirements

- Windows 10/11 desktop session (not a headless server or locked desktop).
- Python 3.10+.
- An HI account and an API key from **HI → API keys**. The key is stored only in your terminal/session environment, not in this repository.
- The HI server must have the desktop skill schema migrated using the normal HI migration process.

## Setup (PowerShell)

From this directory:

```powershell
py -m pip install -r requirements.txt
$env:HI_BASE_URL = "https://hi.nahalabs.co.za"
$env:HI_API_KEY = "hi_your_key_here"
```

Replace the example API key with the key created in your HI account. Do not paste it into chat, source files or committed configuration.

## Record and publish a skill

```powershell
py .\hi_desktop_companion.py record --title "Prepare monthly invoice"
```

Switch to the app, portal or window where you want to demonstrate the workflow. Complete the process as you normally would. Stop with **Ctrl+Shift+F12**. The companion asks whether you want to publish the stopped recording as an HI skill. The skill name must be a lowercase slug such as prepare-monthly-invoice.

If you stop recording without publishing, use the recording ID shown in the terminal:

```powershell
py .\hi_desktop_companion.py publish YOUR-RECORDING-ID
py .\hi_desktop_companion.py list
```

## Execute approved skills

Start the companion worker and leave its terminal open:

```powershell
py .\hi_desktop_companion.py worker
```

Then ask HI in chat to run the saved skill by name, for example:

> Run my desktop skill prepare-monthly-invoice.

HI proposes the task in the normal approval queue. Only after the customer approves it can the local worker claim and run it. A run may stop for manual handling if the application layout differs from the recording or a target is ambiguous.

## API endpoints

All endpoints use HI's existing tenant API key (Authorization: Bearer hi_...) and existing tenant isolation.

- GET /v1/desktop/recordings
- POST /v1/desktop/recordings with {"title":"..."}
- POST /v1/desktop/recordings/:id/actions with {"action":{...}}
- POST /v1/desktop/recordings/:id/stop
- POST /v1/desktop/recordings/:id/publish with {"name":"prepare-monthly-invoice","description":"..."}
- GET /v1/desktop/skills
- POST /v1/desktop/tasks/claim with the local worker ID
- POST /v1/desktop/tasks/:id/result with the worker ID and a redacted result

The task claim endpoint atomically claims one approved task so two computers do not start it concurrently. Execution results are kept in the HI approval/audit record. Do not make the API key available to the agent or to untrusted application content.
