#!/usr/bin/env python3
"""HI Phone Bridge - runs on the customer's own machine, next to their paired Android phone.

Polls HI for phone tasks the customer has approved in the queue, runs them on the phone
through the local device-automation daemon, and posts the result back. Outbound HTTPS only:
the phone and this machine are never reachable from the internet.

Setup: see bridge/README.md. Required env:
  HI_BASE_URL       e.g. https://hi.nahalabs.co.za
  HI_API_KEY        an API key from the HI app (API keys page)
Optional env:
  ARTEMIS_BASE_URL  local device daemon (default http://127.0.0.1:8000)
  ARTEMIS_TOKEN     daemon token, if set there
  POLL_SECONDS      poll interval (default 15)
"""
import asyncio
import json
import os
import urllib.request

from artemis_client import ArtemisClient

HI = os.environ.get("HI_BASE_URL", "").rstrip("/")
KEY = os.environ.get("HI_API_KEY", "")
ART = os.environ.get("ARTEMIS_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
TOK = os.environ.get("ARTEMIS_TOKEN") or None
POLL = int(os.environ.get("POLL_SECONDS", "15"))


def hi(method, path, body=None):
    req = urllib.request.Request(
        HI + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", "authorization": "Bearer " + KEY},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read() or b"{}")


async def main():
    if not HI or not KEY:
        raise SystemExit("Set HI_BASE_URL and HI_API_KEY first (see bridge/README.md).")
    client = ArtemisClient(ART, token=TOK)
    devices = await client.list_devices()
    if not devices:
        raise SystemExit("No Android device connected to the local daemon. Plug the phone in with USB debugging on.")
    serial = devices[0].serial
    print(f"HI Phone Bridge up. Device {serial}. Polling {HI} every {POLL}s.")
    while True:
        try:
            tasks = hi("GET", "/v1/phone/tasks").get("tasks", [])
            for t in tasks:
                instruction = (t.get("payload") or {}).get("instruction", "").strip()
                if not instruction:
                    continue
                print(f"Running approved task {t['id']}: {instruction[:80]}")
                try:
                    res = await client.run(instruction, profile="flash", device_serial=serial)
                    ok = bool(res.succeeded)
                    summary = res.error or f"finished with status {res.status}"
                except Exception as e:  # daemon unreachable, device unplugged, etc.
                    ok, summary = False, f"bridge error: {e}"
                hi("POST", f"/v1/phone/tasks/{t['id']}/result", {"status": "executed" if ok else "failed", "summary": summary[:500]})
                print(f"  -> {'done' if ok else 'failed'}: {summary[:120]}")
        except Exception as e:
            print("poll error:", e)
        await asyncio.sleep(POLL)


if __name__ == "__main__":
    asyncio.run(main())
