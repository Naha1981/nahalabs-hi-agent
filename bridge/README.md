# HI Phone Bridge

Pairs an Android phone with an HI account so the agent can propose phone tasks
(open apps, read the screen, tap and type). Every task waits in the HI approval
queue first - the bridge only ever runs tasks you approved, then reports back.

Everything here is free: the bridge and the device-automation runtime are open
source (Apache 2.0), the phone is your own, and the AI model has a free tier.

## What you need

1. An Android phone with **USB debugging** switched on (Developer options),
   plugged into a computer that can stay on while you use the bridge.
2. Python 3.12+ with `uv` on that computer.
3. An HI API key: HI app -> **API keys** -> create key (shown once).
4. A free AI-studio model key for the automation runtime.

## Setup (about 10 minutes)

```bash
# 1. Install the device-automation runtime and start its daemon
git clone https://github.com/google/artemis.git && cd artemis
cp .env.example .env      # put your free model key into GEMINI_API_KEY
./start.sh                # installs ADB and friends, starts the daemon on 127.0.0.1:8000

# 2. Install the HI bridge
uv add "artemis-client @ git+https://github.com/google/artemis.git#subdirectory=packages/artemis-client"

# 3. Run the bridge (keep it running)
export HI_BASE_URL="https://hi.nahalabs.co.za"
export HI_API_KEY="hi_..."          # your HI API key
python3 phone_bridge.py
```

Then in HI just ask, e.g. "open Settings on my phone and read the battery
percentage". HI drafts the task, you approve it in the queue, the bridge runs
it and reports back. Nothing reaches the phone without your approval.

## Notes

- The daemon has no built-in remote authentication; the bridge talks to it on
  localhost only and polls HI outbound, so no ports are exposed.
- One phone per bridge. For a team, each person runs their own bridge with
  their own HI API key; tasks stay inside their own account.
- Automating another app's UI (for example a messaging app) can be against
  that app's terms. HI proposes; you decide what to approve on your own phone.
