#!/usr/bin/env python3
"""HI Desktop Companion (Windows-first).

Records explicitly started user demonstrations as semantic UI metadata only. It never stores typed
values, screenshots or clipboard contents. Approved skills replay locally on the customer's machine.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import queue
import re
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    import psutil
    import win32gui
    import win32process
    from pynput import keyboard, mouse
    from pywinauto import Desktop
    from pywinauto import keyboard as pywinauto_keyboard
    from pywinauto import mouse as pywinauto_mouse
except ImportError as exc:
    print("Missing Windows companion dependencies. Run: py -m pip install -r requirements.txt")
    print("Import error:", exc)
    raise SystemExit(2)

SENSITIVE_RE = re.compile(r"password|passcode|secret|token|one[ -]?time|verification|credit[ -]?card|security[ -]?code|(?:^|[^a-z])(?:cc-|cvc|cvv|pin|otp)(?![a-z])", re.I)
IRREVERSIBLE_RE = re.compile(r"\b(submit|send|pay|buy|purchase|order|checkout|confirm|book|reserve|publish|delete|remove|cancel|register|subscribe|apply|transfer|authorize|authorise|accept|agree|sign)\b", re.I)
SAFE_KEYS = {
    keyboard.Key.enter: "Enter", keyboard.Key.tab: "Tab", keyboard.Key.esc: "Escape",
    keyboard.Key.backspace: "Backspace", keyboard.Key.delete: "Delete",
    keyboard.Key.up: "ArrowUp", keyboard.Key.down: "ArrowDown",
    keyboard.Key.left: "ArrowLeft", keyboard.Key.right: "ArrowRight",
    keyboard.Key.home: "Home", keyboard.Key.end: "End",
    keyboard.Key.page_up: "PageUp", keyboard.Key.page_down: "PageDown",
}
KEY_TO_SEND = {
    "Enter": "{ENTER}", "Tab": "{TAB}", "Escape": "{ESC}", "Backspace": "{BACKSPACE}",
    "Delete": "{DELETE}", "ArrowUp": "{UP}", "ArrowDown": "{DOWN}",
    "ArrowLeft": "{LEFT}", "ArrowRight": "{RIGHT}", "Home": "{HOME}",
    "End": "{END}", "PageUp": "{PGUP}", "PageDown": "{PGDN}",
}

def api_config() -> tuple[str, str]:
    base = os.environ.get("HI_BASE_URL", "").strip().rstrip("/")
    key = os.environ.get("HI_API_KEY", "").strip()
    if not base or not key:
        raise RuntimeError("Set HI_BASE_URL and HI_API_KEY in this terminal before starting the companion.")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("HI_BASE_URL must use HTTPS (HTTP is allowed only for local testing).")
    if not key.startswith("hi_"):
        raise RuntimeError("HI_API_KEY does not look like an HI API key.")
    return base, key

class HIClient:
    def __init__(self) -> None:
        self.base, self.key = api_config()

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base + path, method=method, data=data,
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json", "User-Agent": "HI-Desktop-Companion/0.1"},
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read()
                    return json.loads(raw.decode("utf-8")) if raw else {}
            except urllib.error.HTTPError as exc:
                if exc.code == 429 and attempt < 3:
                    time.sleep(2 + attempt * 2)
                    continue
                detail = ""
                try:
                    payload = json.loads(exc.read().decode("utf-8"))
                    detail = str(payload.get("error", ""))
                except Exception:
                    pass
                raise RuntimeError("HI API returned HTTP " + str(exc.code) + (": " + detail if detail else "")) from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 3:
                    time.sleep(1 + attempt)
                    continue
                raise RuntimeError("Could not reach HI API: " + str(getattr(exc, "reason", exc))) from None
        raise RuntimeError("HI API request failed.")

def safe_text(value: Any, limit: int = 120) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[redacted]", text, flags=re.I)
    text = re.sub(r"\b\d{13}\b", "[redacted]", text)
    text = re.sub(r"\b[A-Za-z0-9_+/=-]{36,}\b", "[redacted]", text)
    return text[:limit]

def get_rect(wrapper: Any) -> Any:
    try:
        return wrapper.rectangle()
    except Exception:
        return None

def normalized_rect(element_rect: Any, window_rect: Any) -> dict[str, float] | None:
    if not element_rect or not window_rect:
        return None
    width = max(1, window_rect.right - window_rect.left)
    height = max(1, window_rect.bottom - window_rect.top)
    x = (element_rect.left - window_rect.left) / width
    y = (element_rect.top - window_rect.top) / height
    w = (element_rect.right - element_rect.left) / width
    h = (element_rect.bottom - element_rect.top) / height
    clamp = lambda n: max(0.0, min(1.0, float(n)))
    return {"x": clamp(x), "y": clamp(y), "width": clamp(w), "height": clamp(h)}

def current_context(x: int | None = None, y: int | None = None, focused: bool = False) -> tuple[Any, dict[str, Any]] | None:
    """Return the foreground window and a target descriptor without reading control values."""
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        desktop = Desktop(backend="uia")
        window = desktop.window(handle=hwnd).wrapper_object()
        title = safe_text(win32gui.GetWindowText(hwnd) or window.element_info.name, 160) or "Untitled window"
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        process_name = psutil.Process(pid).name()
        window_rect = get_rect(window)
        try:
            element = desktop.get_focus() if focused else desktop.from_point(int(x), int(y))
            info = element.element_info
            if int(getattr(info, "process_id", pid)) != pid:
                raise RuntimeError("control belongs to a different process")
            control_type = safe_text(getattr(info, "control_type", ""), 60)
            raw_name = safe_text(getattr(info, "name", ""), 120)
            automation_id = safe_text(getattr(info, "automation_id", ""), 100)
            class_name = safe_text(getattr(info, "class_name", ""), 100)
            is_password = bool(getattr(info, "is_password", False))
            rect = normalized_rect(get_rect(element), window_rect)
            sensitive = is_password or bool(SENSITIVE_RE.search(" ".join([raw_name, automation_id, class_name])))
            # UI Automation may expose a field's current value through its Name property.
            # Never persist that property for any text-entry surface.
            input_control = control_type in {"Edit", "ComboBox", "Document", "Text"}
            control_name = "[sensitive field]" if sensitive else ("[input field]" if input_control else (raw_name or control_type))
            if not control_type:
                raise RuntimeError("control has no accessible type")
            target = {
                "window_title": title, "process_name": process_name,
                "control_name": control_name,
                "control_type": control_type, "automation_id": "" if sensitive else automation_id,
                "class_name": class_name, "sensitive": sensitive, "rect": rect,
            }
            return window, target
        except Exception:
            if focused:
                return None
            if not window_rect:
                return None
            ww = max(1, window_rect.right - window_rect.left)
            wh = max(1, window_rect.bottom - window_rect.top)
            target = {
                "window_title": title, "process_name": process_name,
                "control_name": "Coordinate-only target", "control_type": "Coordinate",
                "automation_id": "", "class_name": "", "sensitive": False,
                "rect": {
                    "x": max(0.0, min(1.0, (int(x) - window_rect.left) / ww)),
                    "y": max(0.0, min(1.0, (int(y) - window_rect.top) / wh)),
                    "width": 0.0, "height": 0.0,
                },
            }
            return window, target
    except Exception:
        return None

def is_companion_terminal(target: dict[str, Any]) -> bool:
    # Avoid recording commands typed into the terminal used to control the companion itself.
    return target.get("process_name", "").lower() in {"python.exe", "pythonw.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "cmd.exe"}

class Recorder:
    def __init__(self, client: HIClient, recording_id: str) -> None:
        self.client = client
        self.recording_id = recording_id
        self.stop_event = threading.Event()
        self.queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.lock = threading.Lock()
        self.held: set[str] = set()
        self.typed_fingerprints: set[str] = set()
        self.parameter_count = 0
        self.last_error: str | None = None
        self.sender = threading.Thread(target=self._send_loop, name="hi-desktop-action-sender", daemon=True)

    def _send_loop(self) -> None:
        while True:
            action = self.queue.get()
            try:
                if action is None:
                    return
                self.client.request("POST", "/v1/desktop/recordings/" + self.recording_id + "/actions", {"action": action})
                # Stay within HI's per-key rate limit even on a very fast user session.
                time.sleep(0.55)
            except Exception as exc:
                self.last_error = str(exc)
                self.stop_event.set()
            finally:
                self.queue.task_done()

    def _queue(self, action: dict[str, Any]) -> None:
        if not self.stop_event.is_set():
            # The API receives action type and selector metadata only. No keystroke values or screenshots.
            self.queue.put(action)

    def _fingerprint(self, target: dict[str, Any]) -> str:
        return "|".join(str(target.get(k, "")) for k in ("window_title", "process_name", "control_type", "automation_id", "control_name"))

    def on_click(self, x: int, y: int, button: Any, pressed: bool) -> None:
        if pressed or button != mouse.Button.left or self.stop_event.is_set():
            return
        self.typed_fingerprints.clear()
        found = current_context(x, y, focused=False)
        if not found:
            return
        _, target = found
        if is_companion_terminal(target):
            return
        self._queue({"type": "click", "target": target})

    def on_scroll(self, x: int, y: int, dx: int, dy: int) -> None:
        if self.stop_event.is_set() or not dy:
            return
        found = current_context(x, y, focused=False)
        if not found:
            return
        _, target = found
        if is_companion_terminal(target) or target.get("sensitive"):
            return
        self._queue({"type": "scroll", "delta_y": max(-1200, min(1200, int(-dy * 120))), "target": target})

    def on_press(self, key: Any) -> bool | None:
        token = getattr(key, "name", None) or getattr(key, "char", None) or str(key)
        token = str(token).lower()
        with self.lock:
            self.held.add(token)
            held = set(self.held)
        if token == "f12" and any(x.startswith("ctrl") for x in held) and any(x.startswith("shift") for x in held):
            self.stop_event.set()
            return False
        if any(x.startswith(("ctrl", "alt", "cmd", "win")) for x in held):
            return None
        if key in SAFE_KEYS:
            found = current_context(focused=True)
            if found:
                _, target = found
                if not target.get("sensitive") and not is_companion_terminal(target):
                    self.typed_fingerprints.clear()
                    self._queue({"type": "key", "key": SAFE_KEYS[key], "target": target})
            return None
        char = getattr(key, "char", None)
        if not char or not str(char).isprintable():
            return None
        found = current_context(focused=True)
        if not found:
            return None
        _, target = found
        if is_companion_terminal(target) or target.get("sensitive"):
            return None
        if target.get("control_type") not in {"Edit", "ComboBox", "Document", "Text"}:
            return None
        fingerprint = self._fingerprint(target)
        if fingerprint in self.typed_fingerprints:
            return None
        self.typed_fingerprints.add(fingerprint)
        self.parameter_count += 1
        self._queue({"type": "type", "parameter": "input_" + str(self.parameter_count), "target": target})
        return None

    def on_release(self, key: Any) -> None:
        token = getattr(key, "name", None) or getattr(key, "char", None) or str(key)
        with self.lock:
            self.held.discard(str(token).lower())

    def run(self) -> None:
        print("\nRecording is active. Switch to the app/window you want HI to learn.")
        print("Only clicks, scrolls, safe navigation keys and placeholder typing steps are recorded.")
        print("Typed values, passwords, clipboard content and screenshots are NOT stored.")
        print("Stop with Ctrl+Shift+F12 or wait for the 10-minute limit.\n")
        self.sender.start()
        mouse_listener = mouse.Listener(on_click=self.on_click, on_scroll=self.on_scroll)
        key_listener = keyboard.Listener(on_press=self.on_press, on_release=self.on_release)
        started = time.monotonic()
        mouse_listener.start()
        key_listener.start()
        try:
            while not self.stop_event.wait(0.2):
                elapsed = time.monotonic() - started
                if elapsed >= 600:
                    self.stop_event.set()
                    break
                if self.last_error:
                    break
        finally:
            self.stop_event.set()
            mouse_listener.stop()
            key_listener.stop()
            mouse_listener.join(timeout=3)
            key_listener.join(timeout=3)
            self.queue.join()
            self.queue.put(None)
            self.queue.join()
            self.sender.join(timeout=3)
        print("Recorder stopped. Saved actions: " + str(self.parameter_count) + " typing placeholder(s) plus other actions.")
        if self.last_error:
            print("Recording transport stopped because HI could not save an action: " + self.last_error)
            print("Review the recording in HI before publishing it.")
        try:
            result = self.client.request("POST", "/v1/desktop/recordings/" + self.recording_id + "/stop", {})
            print("Recording status: " + str(result.get("status", "stopped")))
        except Exception as exc:
            print("Could not stop the server recording automatically: " + str(exc))
        print("Recording ID: " + self.recording_id)

def worker_id() -> str:
    folder = Path.home() / ".nahalabs-hi"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "desktop-worker-id"
    if path.exists():
        try:
            value = path.read_text(encoding="utf-8").strip()
            if str(uuid.UUID(value)) == value:
                return value
        except Exception:
            pass
    value = str(uuid.uuid4())
    path.write_text(value, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return value

def locate_window(target: dict[str, Any]) -> Any | None:
    desktop = Desktop(backend="uia")
    wanted_process = str(target.get("process_name", "")).lower()
    wanted_title = str(target.get("window_title", ""))
    matches = []
    try:
        windows = desktop.windows(visible_only=True)
    except Exception:
        return None
    for window in windows:
        try:
            info = window.element_info
            pid = int(getattr(info, "process_id", 0))
            proc = psutil.Process(pid).name().lower()
            title = safe_text(getattr(info, "name", ""), 160)
            if proc == wanted_process and title == wanted_title:
                matches.append(window)
        except Exception:
            continue
    return matches[0] if len(matches) == 1 else None

def locate_control(window: Any, target: dict[str, Any]) -> Any | None:
    if target.get("control_type") == "Coordinate" or target.get("sensitive"):
        return None
    try:
        candidates = window.descendants(control_type=target.get("control_type"))
    except Exception:
        return None
    exact = []
    for control in candidates[:1500]:
        try:
            info = control.element_info
            if target.get("automation_id") and str(info.automation_id or "") != target["automation_id"]:
                continue
            if not target.get("automation_id") and str(info.name or "") != target.get("control_name", ""):
                continue
            if str(info.control_type or "") != target.get("control_type", ""):
                continue
            exact.append(control)
        except Exception:
            continue
    return exact[0] if len(exact) == 1 else None

def prompt_for_inputs(actions: list[dict[str, Any]]) -> dict[str, str]:
    parameters = []
    for action in actions:
        if action.get("type") == "type" and action.get("parameter") and action["parameter"] not in parameters:
            parameters.append(action["parameter"])
    values: dict[str, str] = {}
    for parameter in parameters:
        value = input("Value for " + parameter + " (entered locally; not sent back to HI): ")
        if len(value) > 1000:
            raise RuntimeError("Input for " + parameter + " exceeds 1000 characters.")
        values[parameter] = value
    return values

def run_approved_task(client: HIClient, task: dict[str, Any]) -> tuple[str, str]:
    actions = task.get("actions") if isinstance(task.get("actions"), list) else []
    if not actions:
        return "failed", "The saved skill contains no actions."
    print("\nApproved task: " + safe_text(task.get("skill_name"), 80) + " (" + str(len(actions)) + " steps)")
    print("Review each action. The companion does not upload values typed during replay.")
    values = prompt_for_inputs(actions)
    completed = 0
    manual = 0
    try:
        for index, action in enumerate(actions, start=1):
            gate = client.request("POST", "/v1/desktop/tasks/" + str(task["id"]) + "/check", {"worker_id": task["worker_id"]})
            if gate.get("allowed") is not True:
                return "failed", safe_text(gate.get("reason", "HI blocked this task."), 300)
            kind = action.get("type")
            target = action.get("target") or {}
            label = safe_text(target.get("control_name", target.get("control_type", "control")), 100)
            if target.get("sensitive"):
                input("Step " + str(index) + " needs you to handle a sensitive field manually. Complete it yourself, then press Enter to continue.")
                manual += 1
                continue
            if kind == "click" and (target.get("control_type") == "Coordinate" or IRREVERSIBLE_RE.search(label)):
                answer = input("Step " + str(index) + " clicks \"" + label + "\". Confirm locally (type yes): ").strip().lower()
                if answer != "yes":
                    return "failed", "Stopped before a locally gated click at step " + str(index) + "."
            window = locate_window(target)
            if not window:
                answer = input("Step " + str(index) + " cannot identify the expected window. Bring it to the foreground, then press Enter to retry or type skip: ").strip().lower()
                if answer == "skip":
                    manual += 1
                    continue
                window = locate_window(target)
                if not window:
                    return "failed", "Could not uniquely identify the expected application window at step " + str(index) + "."
            control = locate_control(window, target)
            if kind in {"click", "type", "key"} and not control and target.get("control_type") != "Coordinate":
                answer = input("Step " + str(index) + " cannot uniquely identify \"" + label + "\". Complete this step manually and type skip, or press Enter to retry: ").strip().lower()
                if answer == "skip":
                    manual += 1
                    continue
                control = locate_control(window, target)
                if not control and target.get("control_type") != "Coordinate":
                    return "failed", "Could not uniquely identify a control at step " + str(index) + ". No action was guessed."
            if kind == "click":
                if target.get("control_type") == "Coordinate":
                    rect = target.get("rect") or {}
                    wr = window.rectangle()
                    x = int(wr.left + max(0.0, min(1.0, float(rect.get("x", 0.5)))) * max(1, wr.right - wr.left))
                    y = int(wr.top + max(0.0, min(1.0, float(rect.get("y", 0.5)))) * max(1, wr.bottom - wr.top))
                    pywinauto_mouse.click(coords=(x, y))
                else:
                    control.click_input()
            elif kind == "type":
                value = values.get(str(action.get("parameter")), "")
                control.click_input()
                pywinauto_keyboard.send_keys("^a")
                # Escape pywinauto's brace syntax so input is typed literally.
                pywinauto_keyboard.send_keys(value.replace("{", "{{").replace("}", "}}"), with_spaces=True, pause=0.01)
            elif kind == "key":
                sequence = KEY_TO_SEND.get(str(action.get("key")))
                if not sequence:
                    return "failed", "Unsupported key was refused at step " + str(index) + "."
                if control:
                    control.click_input()
                pywinauto_keyboard.send_keys(sequence)
            elif kind == "scroll":
                rect = target.get("rect") or {}
                wr = window.rectangle()
                x = int(wr.left + (float(rect.get("x", 0.5)) + float(rect.get("width", 0)) / 2) * max(1, wr.right - wr.left))
                y = int(wr.top + (float(rect.get("y", 0.5)) + float(rect.get("height", 0)) / 2) * max(1, wr.bottom - wr.top))
                wheel = max(-10, min(10, int(float(action.get("delta_y", 0)) / 120)))
                if wheel:
                    pywinauto_mouse.scroll(coords=(x, y), wheel_dist=wheel)
            else:
                return "failed", "Unsupported recorded action at step " + str(index) + "."
            completed += 1
            time.sleep(0.15)
    except KeyboardInterrupt:
        return "failed", "Execution interrupted locally by the operator."
    except Exception as exc:
        return "failed", "Execution stopped safely after " + str(completed) + " steps (" + type(exc).__name__ + ")."
    return "executed", "Completed " + str(completed) + " steps; " + str(manual) + " step(s) required manual handling."

def publish_recording(client: HIClient, recording_id: str) -> None:
    name = input("Skill name (lowercase slug, e.g. process-invoice): ").strip()
    description = input("Short description (no customer data): ").strip()
    result = client.request("POST", "/v1/desktop/recordings/" + recording_id + "/publish", {"name": name, "description": description})
    skill = result.get("skill") or {}
    print("Saved HI skill: " + str(skill.get("name", name)))
    print("Ask HI to run it by name. Each run still needs approval in the HI approvals queue.")

def main() -> int:
    parser = argparse.ArgumentParser(description="Record Windows desktop workflows into HI and replay only customer-approved tasks.")
    sub = parser.add_subparsers(dest="command", required=True)
    rec = sub.add_parser("record", help="Record a demonstrated workflow")
    rec.add_argument("--title", required=True, help="Short workflow title")
    pub = sub.add_parser("publish", help="Publish a stopped recording as a saved HI skill")
    pub.add_argument("recording_id")
    sub.add_parser("worker", help="Poll HI for approved tasks and execute them locally")
    sub.add_parser("list", help="List recordings and saved desktop skills")
    args = parser.parse_args()
    try:
        client = HIClient()
        if args.command == "record":
            created = client.request("POST", "/v1/desktop/recordings", {"title": args.title}).get("recording", {})
            recording_id = created.get("id")
            if not recording_id:
                raise RuntimeError("HI did not return a recording id.")
            recorder = Recorder(client, recording_id)
            recorder.run()
            if not recorder.last_error and input("Publish this stopped recording as a reusable skill now? [y/N] ").strip().lower() == "y":
                publish_recording(client, recording_id)
            return 0
        if args.command == "publish":
            publish_recording(client, args.recording_id)
            return 0
        if args.command == "list":
            recs = client.request("GET", "/v1/desktop/recordings").get("recordings", [])
            skills = client.request("GET", "/v1/desktop/skills").get("skills", [])
            print("Recent recordings:")
            for row in recs:
                print("- {title} [{status}] steps={actions_count} id={id}{skill}".format(
                    title=safe_text(row.get("title"), 80), status=row.get("status"),
                    actions_count=row.get("actions_count"), id=row.get("id"),
                    skill=(" skill=" + str(row.get("skill_name"))) if row.get("skill_name") else "",
                ))
            print("Saved desktop skills:")
            for skill in skills:
                print("- {name}: {description} ({actions_count} steps)".format(
                    name=skill.get("name"), description=safe_text(skill.get("description"), 100), actions_count=skill.get("actions_count"),
                ))
            return 0
        if args.command == "worker":
            ident = worker_id()
            print("HI desktop worker is running locally. Keep this terminal open. Press Ctrl+C to stop.")
            print("Only approved tasks are claimed. Run a single worker per HI tenant.")
            while True:
                try:
                    result = client.request("POST", "/v1/desktop/tasks/claim", {"worker_id": ident})
                    task = result.get("task")
                    if not task:
                        time.sleep(3)
                        continue
                    status, summary = run_approved_task(client, task)
                    client.request("POST", "/v1/desktop/tasks/" + str(task["id"]) + "/result", {
                        "worker_id": ident, "status": status, "summary": summary,
                    })
                    print("Task " + str(task["id"]) + ": " + summary)
                except KeyboardInterrupt:
                    print("\nWorker stopped.")
                    return 0
                except Exception as exc:
                    print("Worker error: " + str(exc))
                    time.sleep(5)
    except Exception as exc:
        print("HI Desktop Companion: " + str(exc))
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
