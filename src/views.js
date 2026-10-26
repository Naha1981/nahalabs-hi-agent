export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fdate = (d) => d ? new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : 'not stated';
export const safeUrl = (u) => /^https:\/\//i.test(String(u)) ? esc(u) : '#';

// One design system for the whole app: white surfaces, 1px neutral borders, 12px radii,
// black primary actions, muted helper text. Restraint is the premium look: no decoration.
const CSS = `
:root{--ink:#171717;--text:#171717;--mut:#737373;--bg:#ffffff;--soft:#fafafa;--panel:#ffffff;--line:#e8e8e8;--chip:#f5f5f5;--ok:#15803d;--bad:#dc2626;--gold:#8a6d1d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--ink)}
h1{font-size:28px;line-height:1.2;margin:.1em 0 .5em;letter-spacing:-.02em}h2{font-size:19px;margin:1.4em 0 .5em;letter-spacing:-.01em}
.mut{color:var(--mut);font-size:15px}.small{font-size:13px}.bad{color:var(--bad)}.ok{color:var(--ok)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.03);overflow-x:auto}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.chip,.tag{display:inline-block;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 12px;font-size:13px;color:var(--text);margin:1px 2px;text-decoration:none}
.tag{color:var(--mut)}
.score{background:var(--ink);color:#fff;border-radius:999px;padding:3px 12px;font-weight:700;font-size:14px}
input,textarea,select{width:100%;background:#fff;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:11px 12px;font:inherit}
input:focus,textarea:focus,select:focus{outline:2px solid rgba(23,23,23,.15);outline-offset:1px;border-color:#c9c9c9}
label{display:block;margin:14px 0 4px;color:var(--mut);font-size:14px;font-weight:500}
button,.btn{background:var(--ink);color:#fff;border:1px solid var(--ink);border-radius:8px;padding:10px 20px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font:inherit;font-size:15px;line-height:1.3;min-height:44px}
button:hover,.btn:hover{background:#000}button.sec,.btn.sec{background:#fff;color:var(--text);border:1px solid var(--line)}button.sec:hover,.btn.sec:hover{background:var(--soft)}
button.danger,button.sec.danger{background:#fff;color:var(--bad);border:1px solid var(--bad)}button.danger:hover{background:var(--bad);color:#fff}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:14px;font-size:14px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:10px 9px;text-align:left;font-size:15px;vertical-align:top;overflow-wrap:break-word}
.flash{background:#fffbeb;border:1px solid #fcd34d;color:#78350f;padding:12px 16px;border-radius:10px;margin:12px 0;font-size:15px}
code{background:var(--chip);border-radius:6px;padding:1px 6px;font-size:14px;overflow-wrap:anywhere;word-break:break-all}
/* public pages */
.pub-h{display:flex;gap:18px;align-items:center;justify-content:space-between;padding:14px 26px;border-bottom:1px solid var(--line);background:#fff}
.brand{font-weight:800;letter-spacing:-.02em;color:var(--ink);text-decoration:none;font-size:21px}.brand small{color:var(--mut);font-weight:500;letter-spacing:0;margin-left:8px;font-size:13px}
.pub-m{max-width:980px;margin:0 auto;padding:32px 22px}
.pub-f{padding:22px 26px;text-align:center;color:var(--mut);font-size:14px;border-top:1px solid var(--line);margin-top:32px}
.hero{text-align:center;padding:16px 0 4px}.hero h1{font-size:40px;margin:.1em 0 .3em}
.lede{font-size:19px;max-width:560px;margin:0 auto 18px;color:var(--text)}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:18px 0 26px}
.cta .btn{padding:13px 34px;font-size:16px}
.shot{margin:0 auto;max-width:340px}.shot img{width:100%;display:block;border:1px solid var(--line);border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.07)}
.feat{display:grid;grid-template-columns:1fr;gap:10px;max-width:640px;margin:24px auto 0;text-align:left}
.feat .card{margin:0;padding:14px 18px}
@media(min-width:700px){.feat{grid-template-columns:1fr 1fr}}
.auth{max-width:400px;margin:32px auto}
.auth .card{overflow-x:visible}
@media(max-width:480px){
.card{padding:14px 12px;scroll-margin-top:70px}
td,th{padding:7px 5px;font-size:14px}
table.mem thead{display:none}
table.mem tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}
table.mem td{display:block;border:0;padding:2px 0;overflow-wrap:break-word}
table.mem td.mmeta{display:inline;color:var(--mut);font-size:13px;padding-right:0}
table.mem td.mmeta+td.mmeta::before{content:" · "}
}
.auth h1{text-align:center}
/* signed-in shell */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--line);background:#fff;position:sticky;top:0;z-index:20}
.side{display:none}
.appmain{max-width:760px;margin:0 auto;padding:20px 16px 100px}
.tabs{position:fixed;bottom:0;left:0;right:0;display:flex;background:#fff;border-top:1px solid var(--line);z-index:20;padding:6px 2px calc(6px + env(safe-area-inset-bottom))}
.tabs a{flex:1;text-align:center;text-decoration:none;color:var(--mut);font-size:12px;font-weight:600;padding:12px 4px;letter-spacing:-.01em;min-height:44px;display:flex;align-items:center;justify-content:center}
.tabs a:hover{color:var(--ink)}
@media(min-width:900px){
.topbar,.tabs{display:none}
.side{display:flex;flex-direction:column;position:fixed;top:0;bottom:0;left:0;width:232px;border-right:1px solid var(--line);padding:20px 14px;background:#fff}
.side nav{display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto;margin-top:14px}
.side .grp{color:var(--mut);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:16px 10px 4px}
a.nl{display:block;padding:12px 10px;border-radius:8px;text-decoration:none;color:var(--text);font-size:14px;font-weight:500}
a.nl:hover{background:var(--soft)}
.side form{padding:10px}
.appmain{margin-left:232px;max-width:840px;padding:32px 28px}
}
/* chat */
.msg{border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin:10px 0;background:#fff}
.msg.me{background:var(--soft)}
.who{font-size:12px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.ask{display:inline-block;margin:4px 6px 0 0}.ask button{font-size:14px;padding:8px 14px}
/* empty states */
.empty{text-align:center;color:var(--mut);padding:28px 18px}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const GROUPS = [
  ['', [['Agent', '/app/agent'], ['Estate', '/app/estate'], ['Opportunities', '/app'], ['Approvals', '/app/approvals'], ['Briefs', '/app/briefs'], ['Tasks', '/app/tasks']]],
  ['Work', [['Browser', '/app/browser'], ['Drive', '/app/drive'], ['WhatsApp', '/app/whatsapp'], ['Files', '/app/files'], ['Documents', '/app/documents']]],
  ['Account', [['Memory', '/app/memory'], ['Profile', '/app/profile'], ['Integrations', '/app/integrations'], ['API keys', '/app/api-keys'], ['Audit log', '/app/audit'], ['Settings', '/app/settings']]],
];
const sideNav = GROUPS.map(([g, links]) => `${g ? `<div class="grp">${g}</div>` : ''}${links.map(([n, h]) => `<a class="nl" href="${h}">${n}</a>`).join('')}`).join('');
const TABS = [['Agent', '/app/agent'], ['Estate', '/app/estate'], ['Approvals', '/app/approvals'], ['Tasks', '/app/tasks'], ['More', '/app/menu']];
const tabs = TABS.map(([n, h]) => `<a href="${h}">${n}</a>`).join('');

export function page({ title, user, body, flash }) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="HI"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${esc(title)} - HI by NahaLabs</title><style>${CSS}</style></head>`;
  const sw = `<script src="/boot.js" defer></script>`;
  if (!user) {
    return `${head}<body><header class="pub-h"><a class="brand" href="/">HI<small>by NahaLabs</small></a><a class="btn sec" href="/login">Sign in</a></header><main class="pub-m">${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main>
<footer class="pub-f"><p style="margin:0 0 8px"><a href="/developers">Developers</a> &middot; <a href="/developers">API</a></p>HI by NahaLabs (Pty) Ltd. Honest limits: HI researches, remembers, matches, drafts and schedules. It never sends, buys, books or submits anything without your approval, and it can be wrong - check the sources it cites.</footer>${sw}</body></html>`;
  }
  const out = `<form method="post" action="/logout" style="margin:0"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><button class="sec" style="padding:7px 16px;font-size:14px">Sign out</button></form>`;
  return `${head}<body><aside class="side"><a class="brand" href="/app/agent">HI<small>by NahaLabs</small></a><nav>${sideNav}</nav>${out}</aside><header class="topbar"><a class="brand" href="/app/agent">HI<small>by NahaLabs</small></a>${out}</header><main class="appmain">${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main><nav class="tabs">${tabs}</nav>${sw}</body></html>`;
}

// Drive Mode: minimal phone-first voice page. Script and styles are self-hosted (CSP 'self').
export function drivePage({ csrf, voiceOn }) {
  const DRIVE_CSS = CSS + `
main.drive{max-width:520px;margin:0 auto;text-align:center;padding:20px 16px}
.talkbtn{width:180px;height:180px;border-radius:50%;font-size:22px;font-weight:800;margin:26px auto;display:block;background:var(--ink);color:#fff;border:0}
.talkbtn.rec{background:var(--bad);animation:pulse 1.2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.4)}70%{box-shadow:0 0 0 26px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}
.stopbtn{background:#fff;color:var(--bad);border:1px solid var(--bad);border-radius:8px;padding:8px 20px;font-weight:600}
.turn{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin:8px 0;text-align:left;font-size:16px}
.turn.me{border-left:3px solid var(--ink)}.turn.hi{border-left:3px solid var(--ok)}
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff"><title>HI Drive - HI by NahaLabs</title><style>${DRIVE_CSS}</style></head>
<body data-csrf="${esc(csrf)}"><main class="drive">
<h1>HI Drive</h1>
<p id="status" class="mut">${voiceOn ? 'Tap the button and talk.' : 'Voice is not configured on this server yet.'}</p>
<button id="talk" class="talkbtn" ${voiceOn ? '' : 'disabled'}>TALK</button>
<p><button id="stop" class="stopbtn">Stop</button></p>
<div id="log"></div>
<p class="mut small">Keep this page open and the screen on while you use it. The microphone only works while the page is open. HI drafts and proposes; nothing sends, buys, books or submits without your approval on the approvals page.</p>
<p class="small"><a href="#" id="newchat">New conversation</a> &middot; <a href="/app">Back to HI</a></p>
</main><script src="/drive.js"></script></body></html>`;
}
