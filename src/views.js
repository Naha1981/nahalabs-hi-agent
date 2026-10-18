export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fdate = (d) => d ? new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : 'not stated';
export const safeUrl = (u) => /^https:\/\//i.test(String(u)) ? esc(u) : '#';

// NahaLabs "signals" look: light ivory, large type, rounded cards, status chips, honest limits.
const CSS = `
:root{--gold:#8a6d1d;--ink:#1c1a15;--bg:#faf6ec;--panel:#fffdf7;--line:#e6ddc8;--text:#23201a;--mut:#7a7261;--ok:#2e7d4f;--bad:#b3402f;--chip:#f1e9d4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--gold)}header{display:flex;gap:18px;align-items:center;padding:16px 26px;border-bottom:1px solid var(--line);flex-wrap:wrap;background:var(--panel)}
.brand{font-weight:800;letter-spacing:.02em;color:var(--ink);text-decoration:none;font-size:22px}.brand small{color:var(--mut);font-weight:400;letter-spacing:0;margin-left:8px;font-size:14px}
#talkbtn.rec{background:var(--bad);color:#fff;border-color:var(--bad)}
nav{display:flex;gap:16px;flex-wrap:wrap;flex:1}nav a{color:var(--text);text-decoration:none;padding:4px 0;border-bottom:2px solid transparent}nav a:hover{border-color:var(--gold)}
main{max-width:980px;margin:0 auto;padding:28px 22px}h1{font-size:34px;line-height:1.15;margin:.2em 0 .5em;letter-spacing:-.01em}h2{font-size:22px;margin:1.4em 0 .5em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 1px 2px rgba(28,26,21,.04)}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.mut{color:var(--mut);font-size:15px}
.score{background:var(--ink);color:var(--bg);border-radius:999px;padding:3px 12px;font-weight:700;font-size:15px}
.chip,.tag{display:inline-block;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 12px;font-size:14px;color:var(--ink);margin:1px 2px}
.tag{font-size:13px;color:var(--mut)}.bad{color:var(--bad)}.ok{color:var(--ok)}
input,textarea,select{width:100%;background:#fff;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:11px;font:inherit}
label{display:block;margin:12px 0 4px;color:var(--mut);font-size:15px}
button,.btn{background:var(--ink);color:var(--bg);border:0;border-radius:999px;padding:10px 22px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;font:inherit}
button.sec{background:transparent;color:var(--text);border:1px solid var(--line)}button.danger{background:var(--bad);color:#fff}
pre{white-space:pre-wrap;background:#fdfaf2;border:1px solid var(--line);border-radius:12px;padding:14px;font-size:14px;overflow:auto}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:9px;text-align:left;font-size:15px;vertical-align:top}
footer{padding:26px;text-align:center;color:var(--mut);font-size:14px}
.flash{background:#fdf3d7;border:1px solid var(--gold);padding:12px 16px;border-radius:12px;margin:12px 0}
code{background:var(--chip);border-radius:6px;padding:1px 6px;font-size:14px}
`;

export function page({ title, user, body, flash }) {
  const nav = user ? `<nav><a href="/app/drive">Drive</a><a href="/app/agent">Agent</a><a href="/app/tasks">Tasks</a><a href="/app/browser">Browser</a><a href="/app/whatsapp">WhatsApp</a><a href="/app/memory">Memory</a><a href="/app">Opportunities</a><a href="/app/profile">Profile</a><a href="/app/documents">Documents</a><a href="/app/approvals">Approvals</a><a href="/app/briefs">Briefs</a><a href="/app/files">Files</a><a href="/app/integrations">Integrations</a><a href="/app/api-keys">API keys</a><a href="/app/audit">Audit log</a><a href="/app/settings">Settings</a></nav><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button class="sec">Sign out</button></form>` : '<nav><a href="/developers">API</a><a href="/login">Sign in</a></nav>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f3ea"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="HI"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${esc(title)} - HI by NahaLabs</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/">HI<small>the AI employee by NahaLabs</small></a>${nav}</header><main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main>
<footer>HI by NahaLabs (Pty) Ltd. Honest limits: HI researches, remembers, matches, drafts and schedules. It never sends, buys, books or submits anything without your approval, and it can be wrong - check the sources it cites.</footer><script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}</script></body></html>`;
}

// Drive Mode: minimal phone-first voice page. Script and styles are self-hosted (CSP 'self').
export function drivePage({ csrf, voiceOn }) {
  const DRIVE_CSS = CSS + `
main.drive{max-width:520px;margin:0 auto;text-align:center}
.talkbtn{width:180px;height:180px;border-radius:50%;font-size:22px;font-weight:800;margin:26px auto;display:block;background:var(--ink);color:var(--bg);border:0}
.talkbtn.rec{background:var(--bad);animation:pulse 1.2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(179,64,47,.5)}70%{box-shadow:0 0 0 26px rgba(179,64,47,0)}100%{box-shadow:0 0 0 0 rgba(179,64,47,0)}}
.stopbtn{background:transparent;color:var(--bad);border:1px solid var(--bad);border-radius:999px;padding:8px 20px;font-weight:700}
.turn{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin:8px 0;text-align:left;font-size:16px}
.turn.me{border-left:4px solid var(--gold)}.turn.hi{border-left:4px solid var(--ok)}
.small{font-size:14px}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f3ea"><title>HI Drive - HI by NahaLabs</title><style>${DRIVE_CSS}</style></head>
<body data-csrf="${esc(csrf)}"><main class="drive">
<h1>HI Drive</h1>
<p id="status" class="mut">${voiceOn ? 'Tap the button and talk.' : 'Voice is not configured on this server yet.'}</p>
<button id="talk" class="talkbtn" ${voiceOn ? '' : 'disabled'}>TALK</button>
<p><button id="stop" class="stopbtn">Stop</button></p>
<div id="log"></div>
<p class="mut small">Keep this page open and the screen on while you use it. The microphone only works while the page is open. HI drafts and proposes; nothing sends, buys, books or submits without your approval on the approvals page.</p>
<p class="small"><a href="#" id="newchat">New conversation</a> · <a href="/app">Back to HI</a></p>
</main><script src="/drive.js"></script></body></html>`;
}
