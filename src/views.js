export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fdate = (d) => d ? new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : 'not stated';
export const safeUrl = (u) => /^https:\/\//i.test(String(u)) ? esc(u) : '#';

const CSS = `
:root{--gold:#c9a227;--ink:#0b0b0c;--panel:#141416;--line:#2a2a2e;--text:#ecebe6;--mut:#9a988f;--ok:#4caf7d;--bad:#e0605a}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--gold)}header{display:flex;gap:18px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.04em;color:var(--gold);text-decoration:none;font-size:18px}.brand small{color:var(--mut);font-weight:400;letter-spacing:0;margin-left:8px}
nav{display:flex;gap:14px;flex-wrap:wrap;flex:1}nav a{color:var(--text);text-decoration:none;padding:4px 0;border-bottom:2px solid transparent}nav a:hover{border-color:var(--gold)}
main{max-width:980px;margin:0 auto;padding:24px}h1{font-size:26px;margin:.2em 0 .6em}h2{font-size:19px;margin:1.4em 0 .5em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.mut{color:var(--mut);font-size:14px}
.score{background:var(--gold);color:#000;border-radius:999px;padding:2px 10px;font-weight:700;font-size:14px}
.tag{border:1px solid var(--line);border-radius:6px;padding:1px 8px;font-size:13px;color:var(--mut)}.bad{color:var(--bad)}.ok{color:var(--ok)}
input,textarea,select{width:100%;background:#0f0f11;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit}
label{display:block;margin:12px 0 4px;color:var(--mut);font-size:14px}
button,.btn{background:var(--gold);color:#000;border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font:inherit;font-weight:600}
button.sec{background:transparent;color:var(--text);border:1px solid var(--line)}button.danger{background:var(--bad);color:#fff}
pre{white-space:pre-wrap;background:#0f0f11;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:14px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;font-size:14px;vertical-align:top}
footer{padding:24px;text-align:center;color:var(--mut);font-size:13px}.flash{background:#1d1a0d;border:1px solid var(--gold);padding:10px 14px;border-radius:8px;margin:10px 0}
`;

export function page({ title, user, body, flash }) {
  const nav = user ? `<nav><a href="/app/agent">Agent</a><a href="/app/tasks">Tasks</a><a href="/app/browser">Browser</a><a href="/app/whatsapp">WhatsApp</a><a href="/app/memory">Memory</a><a href="/app">Opportunities</a><a href="/app/profile">Profile</a><a href="/app/documents">Documents</a><a href="/app/approvals">Approvals</a><a href="/app/briefs">Briefs</a><a href="/app/audit">Audit log</a><a href="/app/settings">Settings</a></nav><form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button class="sec">Sign out</button></form>` : '<nav><a href="/login">Sign in</a></nav>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - HI by NahaLabs</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/">HI<small>by NahaLabs</small></a>${nav}</header><main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main>
<footer>HI by NahaLabs (Pty) Ltd. Nothing is sent or submitted without your approval.</footer></body></html>`;
}
