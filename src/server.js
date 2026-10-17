import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cookie from '@fastify/cookie';
import { timingSafeEqual, createHash } from 'node:crypto';
const require_hash = (t) => createHash('sha256').update(String(t || '')).digest('hex');
import { withTenant, withSystem, audit, auditFor, closePool } from './db.js';
import { hashPassword, verifyPassword, newToken, tokenHash, makeLimiter } from './auth.js';
import { page, esc, fdate, safeUrl } from './views.js';
import { ingest } from './ingest.js';
import { matchTenant, matchAllTenants } from './match.js';
import { buildBriefsForAll, decideApproval, setEmergencyStop, emergencyStopped, vaultAlerts } from './core.js';
import { explainFit, modelEnabled } from './gateway.js';
import { mailConfigured } from './mail.js';
import { handleInbound, makeAdapter, normalisePhone } from './whatsapp.js';
import { browserStep, browserPoll } from './browser.js';
import { runAgent, runDueTasks, ensureDefaultAgent } from './agent.js';
import { chat as defaultChat, agentModelEnabled } from './gateway.js';

const COOKIE = 'hi_session';
const secretEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
const csrfFor = (token) => tokenHash(token + (process.env.SESSION_SECRET || 'dev-only')).slice(0, 40);
const lines = (s) => String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean).slice(0, 40).map((x) => x.slice(0, 80));
const STATUSES = ['new', 'saved', 'dismissed', 'applied', 'won', 'lost'];
const DOC_TYPES = ['CSD supplier report', 'Tax compliance status (SARS)', 'B-BBEE certificate or affidavit', 'CIPC registration', 'Bank confirmation letter', 'Other'];

export async function buildApp({ fetchImpl = fetch, logger = false, llm = defaultChat, lookup } = {}) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 100 * 1024 });
  await app.register(formbody);
  await app.register(cookie);
  const loginLimit = makeLimiter(8, 10 * 60 * 1000);
  const signupLimit = makeLimiter(Number(process.env.SIGNUP_RATE_MAX || 5), 60 * 60 * 1000);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
    if (req.url.startsWith('/app')) reply.header('cache-control', 'no-store');
  });

  async function sessionOf(req) {
    const token = req.cookies?.[COOKIE];
    if (!token) return null;
    const r = await withSystem((c) => c.query(
      `SELECT u.id user_id, u.email, u.tenant_id, t.name tenant_name, t.paused
       FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash(token)]));
    const u = r.rows[0];
    return u ? { ...u, csrf: csrfFor(token) } : null;
  }
  const guard = async (req, reply) => {
    const s = await sessionOf(req);
    if (!s) { reply.redirect('/login'); return reply; }
    if (req.method === 'POST' && !secretEq(req.body?.csrf, s.csrf)) { reply.code(403).send('Bad request token'); return reply; }
    req.user = s;
  };
  const render = (reply, user, title, body, flash) => reply.type('text/html').send(page({ title, user, body, flash }));
  const csrf = (u) => `<input type="hidden" name="csrf" value="${esc(u.csrf)}">`;
  const flashOf = (req) => req.query?.m ? String(req.query.m).slice(0, 160) : null;

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/healthz/db', async (req, reply) => { try { const r = await withSystem((c) => c.query('SELECT count(*)::int n FROM tenants')); return { ok: true, db: 'ok' }; } catch (e) { return reply.code(503).send({ ok: false, db: 'down' }); } });

  app.get('/', async (req, reply) => {
    const s = await sessionOf(req);
    if (s) return reply.redirect('/app/agent');
    return render(reply, null, 'Opportunity Desk', `
      <h1>Find the South African tenders worth your time.</h1>
      <p>HI reads National Treasury's public eTenders data every day, matches open tenders to your business profile, shows exactly why each one matched, and keeps your compliance documents in view. You approve everything before anything is sent.</p>
      <div class="card"><b>What it does</b><ul><li>Daily matching of open public-sector tenders to your keywords</li><li>Every match shows its reasons and links to the official source and bid documents</li><li>Document tracker with expiry alerts (CSD, tax status, B-BBEE, CIPC)</li><li>Briefs sent to you only after you approve them</li></ul></div>
      <p><a class="btn" href="/login">Sign in</a> <a href="/signup">Have an invite code? Create an account</a></p>
      <p class="mut">Data source: National Treasury eTender Publication Portal, published under the Open Data Commons PDDL. HI does not submit bids on your behalf.</p>`);
  });

  app.get('/signup', async (req, reply) => render(reply, null, 'Create account', `
    <h1>Create your account</h1><form method="post" class="card">
    <label>Invite code</label><input name="invite" required autocomplete="off">
    <label>Company name</label><input name="company" required maxlength="120">
    <label>Email</label><input name="email" type="email" required>
    <label>Password (12+ characters)</label><input name="password" type="password" minlength="12" required autocomplete="new-password">
    <p><button>Create account</button></p></form>`, flashOf(req)));

  app.post('/signup', async (req, reply) => {
    if (!signupLimit(req.ip)) return reply.code(429).send('Too many attempts');
    const { invite, company, email, password } = req.body || {};
    const codes = (process.env.HI_INVITE_CODES || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!codes.length || !codes.some((c) => secretEq(c, invite))) return reply.redirect('/signup?m=' + encodeURIComponent('That invite code is not valid.'));
    if (!company || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '') || String(password || '').length < 12) return reply.redirect('/signup?m=' + encodeURIComponent('Check the company, email and a password of 12+ characters.'));
    const pw = await hashPassword(password);
    try {
      const tenantId = await withSystem(async (c) => {
        const t = (await c.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [String(company).slice(0, 120)])).rows[0].id;
        await c.query('INSERT INTO users (tenant_id, email, pw_hash) VALUES ($1,$2,$3)', [t, String(email).toLowerCase(), pw]);
        return t;
      });
      await withTenant(tenantId, async (c) => {
        await c.query("INSERT INTO profiles (tenant_id, company_name) VALUES (current_setting('app.tenant_id')::uuid,$1)", [String(company).slice(0, 120)]);
        await audit(c, tenantId, 'user:signup', 'tenant.created', {});
      });
    } catch (e) {
      if (String(e.message).includes('users_email_key')) return reply.redirect('/signup?m=' + encodeURIComponent('That email is already registered.'));
      throw e;
    }
    return reply.redirect('/login?m=' + encodeURIComponent('Account created. Sign in to set up your profile.'));
  });

  app.get('/login', async (req, reply) => render(reply, null, 'Sign in', `
    <h1>Sign in</h1><form method="post" class="card">
    <label>Email</label><input name="email" type="email" required autocomplete="username">
    <label>Password</label><input name="password" type="password" required autocomplete="current-password">
    <p><button>Sign in</button></p></form>`, flashOf(req)));

  app.post('/login', async (req, reply) => {
    const email = String(req.body?.email || '').toLowerCase();
    if (!loginLimit(req.ip + '|' + email)) return reply.code(429).send('Too many attempts. Try again later.');
    const u = (await withSystem((c) => c.query('SELECT id, tenant_id, pw_hash FROM users WHERE email=$1', [email]))).rows[0];
    const ok = u ? await verifyPassword(String(req.body?.password || ''), u.pw_hash) : (await verifyPassword('x', 's1$00$00'), false);
    if (!ok) {
      await auditFor(u?.tenant_id || null, 'anonymous', 'login.failed', { email_hash: tokenHash(email).slice(0, 12) });
      return reply.redirect('/login?m=' + encodeURIComponent('Email or password is not right.'));
    }
    const token = newToken();
    await withSystem((c) => c.query("INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '14 days')", [tokenHash(token), u.id, u.tenant_id]));
    await auditFor(u.tenant_id, `user:${u.id}`, 'login.ok', {});
    reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 14 * 86400 });
    return reply.redirect('/app/agent');
  });

  app.post('/logout', { preHandler: guard }, async (req, reply) => {
    await withSystem((c) => c.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(req.cookies[COOKIE])]));
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // ---------- App ----------
  app.get('/app', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'new';
    const data = await withTenant(u.tenant_id, async (c) => {
      const prof = (await c.query('SELECT * FROM profiles LIMIT 1')).rows[0];
      const rows = (await c.query(`SELECT m.ocid, m.score, m.reasons, m.status, t.title, t.tender_no, t.buyer, t.closes_at, t.category
        FROM matches m JOIN tenders t USING (ocid) WHERE m.status=$1 ORDER BY m.score DESC, t.closes_at NULLS LAST LIMIT 100`, [status])).rows;
      const counts = (await c.query('SELECT status, count(*)::int n FROM matches GROUP BY status')).rows;
      const alerts = await vaultAlerts(c);
      const pend = (await c.query("SELECT count(*)::int n FROM approvals WHERE status='proposed'")).rows[0].n;
      return { prof, rows, counts, alerts, pend };
    });
    const tabs = STATUSES.map((s) => { const n = data.counts.find((x) => x.status === s)?.n || 0; return `<a class="tag" href="/app?status=${s}">${s} (${n})</a>`; }).join(' ');
    const cards = data.rows.map((r) => `<div class="card"><div class="row"><a href="/app/opportunity/${encodeURIComponent(r.ocid)}"><b>${esc(r.title)}</b></a><span class="score">${r.score}</span></div>
      <div class="mut">${esc(r.tender_no)} | ${esc(r.buyer)} | closes ${fdate(r.closes_at)}</div>
      <div class="mut">${r.reasons.map((x) => esc(x.text)).join(' - ')}</div></div>`).join('');
    const empty = !data.prof?.keywords?.length ? `<div class="card">Set your keywords first so HI knows what to look for. <a class="btn" href="/app/profile">Set up profile</a></div>` : (!data.rows.length ? '<div class="card mut">No opportunities here yet. HI checks for new tenders daily.</div>' : '');
    const warn = [u.paused ? '<div class="flash">Your account is paused. Nothing will be sent.</div>' : '', data.pend ? `<div class="flash">${data.pend} item(s) waiting for your approval. <a href="/app/approvals">Review</a></div>` : '', data.alerts.length ? `<div class="flash">${data.alerts.length} document(s) expired or expiring within 30 days. <a href="/app/documents">Review</a></div>` : ''].join('');
    return render(reply, u, 'Opportunities', `<h1>Opportunities for ${esc(u.tenant_name)}</h1>${warn}<p>${tabs}</p>${cards}${empty}`, flashOf(req));
  });

  app.get('/app/opportunity/:ocid', { preHandler: guard }, async (req, reply) => {
    const u = req.user, ocid = req.params.ocid;
    const d = await withTenant(u.tenant_id, async (c) => {
      const m = (await c.query('SELECT * FROM matches WHERE ocid=$1', [ocid])).rows[0];
      const t = (await c.query('SELECT * FROM tenders WHERE ocid=$1', [ocid])).rows[0];
      const prof = (await c.query('SELECT * FROM profiles LIMIT 1')).rows[0];
      const docs = (await c.query('SELECT doc_type, title, expires_on FROM vault_docs ORDER BY expires_on NULLS LAST')).rows;
      return { m, t, prof, docs };
    });
    if (!d.t) return reply.code(404).type('text/html').send(page({ title: 'Not found', user: u, body: '<h1>Not found</h1>' }));
    if (d.m && !d.m.ai_note && modelEnabled()) {
      try {
        const note = await explainFit({ tenantId: u.tenant_id, profile: d.prof, tender: d.t, fetchImpl });
        if (note) { await withTenant(u.tenant_id, (c) => c.query('UPDATE matches SET ai_note=$2 WHERE ocid=$1', [ocid, note])); d.m.ai_note = note; }
      } catch { /* model note is optional */ }
    }
    const t = d.t;
    const bids = (t.documents || []).map((x) => `<li><a href="${safeUrl(x.url)}" rel="noopener noreferrer" target="_blank">${esc(x.title || 'Bid document')}</a></li>`).join('') || '<li class="mut">No documents listed in the data.</li>';
    const have = new Set(d.docs.map((x) => x.doc_type));
    const checklist = DOC_TYPES.slice(0, 5).map((x) => `<li>${have.has(x) ? '<span class="ok">on file</span>' : '<span class="bad">not on file</span>'} - ${esc(x)}</li>`).join('');
    const buttons = d.m ? ['saved', 'applied', 'won', 'lost'].map((s) => `<button name="status" value="${s}" class="sec">Mark ${s}</button>`).join(' ') : '';
    return render(reply, u, t.title, `<h1>${esc(t.title)}</h1>
      <div class="card"><div class="mut">Bid no ${esc(t.tender_no)} | ${esc(t.buyer)} | ${esc(t.category)} | ${esc(t.method)}</div>
      <p>Opens ${fdate(t.opens_at)}<br>Closes <b>${fdate(t.closes_at)}</b></p><p>${esc(t.description)}</p>
      <p class="mut">Source: <a href="${safeUrl(t.source_url)}" rel="noopener noreferrer" target="_blank">National Treasury eTenders OCDS record</a> (fetched ${fdate(t.fetched_at)})</p></div>
      ${d.m ? `<div class="card"><b>Why it matched (score ${d.m.score}/100)</b><ul>${d.m.reasons.map((r) => `<li>${esc(r.text)} (${r.points > 0 ? '+' : ''}${r.points})</li>`).join('')}</ul>${d.m.ai_note ? `<p class="mut">AI note, unverified: ${esc(d.m.ai_note)}</p>` : ''}</div>` : ''}
      <div class="card"><b>Bid documents (official)</b><ul>${bids}</ul></div>
      <div class="card"><b>Your documents</b><p class="mut">Typical requirements. Always confirm in the bid pack.</p><ul>${checklist}</ul></div>
      ${d.m ? `<form method="post" action="/app/opportunity/${encodeURIComponent(ocid)}/status" class="card">${csrf(u)}<p>Status: <span class="tag">${esc(d.m.status)}</span></p>${buttons}
        <label>Not for you? Say why (HI learns from this)</label><input name="reason" maxlength="200" placeholder="e.g. too far, wrong trade"><p><button name="status" value="dismissed" class="danger">Dismiss</button></p></form>` : ''}`, flashOf(req));
  });

  app.post('/app/opportunity/:ocid/status', { preHandler: guard }, async (req, reply) => {
    const u = req.user, ocid = req.params.ocid, status = req.body?.status;
    if (!STATUSES.includes(status)) return reply.code(400).send('bad status');
    await withTenant(u.tenant_id, async (c) => {
      const r = await c.query('UPDATE matches SET status=$2, dismiss_reason=$3, updated_at=now() WHERE ocid=$1 RETURNING ocid', [ocid, status, status === 'dismissed' ? String(req.body.reason || '').slice(0, 200) : null]);
      if (!r.rowCount) return;
      if (status === 'dismissed') {
        const t = (await c.query('SELECT buyer FROM tenders WHERE ocid=$1', [ocid])).rows[0];
        if (t?.buyer) await c.query("INSERT INTO memory_notes (tenant_id, kind, subject, detail) VALUES (current_setting('app.tenant_id')::uuid,'dismiss_buyer',$1,$2)", [t.buyer, String(req.body.reason || '').slice(0, 200)]);
      }
      if (['won', 'lost', 'applied'].includes(status)) await c.query("INSERT INTO memory_notes (tenant_id, kind, subject, detail) VALUES (current_setting('app.tenant_id')::uuid,'outcome',$1,$2)", [ocid, status]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'match.status', { ocid, status });
    });
    return reply.redirect(`/app?m=${encodeURIComponent('Saved.')}`);
  });

  app.get('/app/profile', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const p = (await withTenant(u.tenant_id, (c) => c.query('SELECT * FROM profiles LIMIT 1'))).rows[0] || {};
    return render(reply, u, 'Profile', `<h1>What should HI look for?</h1><form method="post" class="card">${csrf(u)}
      <label>Company name</label><input name="company_name" value="${esc(p.company_name)}" maxlength="120">
      <label>Keywords (one per line or comma separated). Example: security guarding, cleaning services, CCTV</label><textarea name="keywords" rows="4">${esc((p.keywords || []).join('\n'))}</textarea>
      <label>Exclude terms (tenders with these are never shown)</label><textarea name="exclude_keywords" rows="2">${esc((p.exclude_keywords || []).join('\n'))}</textarea>
      <label>Categories you serve</label><select name="categories" multiple size="3">${['goods', 'services', 'works'].map((x) => `<option value="${x}" ${(p.categories || []).includes(x) ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label>Favour buyers whose name contains (municipality, province, department)</label><textarea name="buyer_terms" rows="2">${esc((p.buyer_terms || []).join('\n'))}</textarea>
      <label>Notes to HI (kept in your memory)</label><textarea name="notes" rows="3" maxlength="1000">${esc(p.notes)}</textarea>
      <p><button>Save and re-match</button></p></form>`, flashOf(req));
  });

  app.post('/app/profile', { preHandler: guard }, async (req, reply) => {
    const u = req.user, b = req.body || {};
    const cats = [].concat(b.categories || []).filter((x) => ['goods', 'services', 'works'].includes(x));
    await withTenant(u.tenant_id, async (c) => {
      await c.query(`INSERT INTO profiles (tenant_id, company_name, keywords, exclude_keywords, categories, buyer_terms, notes)
        VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id) DO UPDATE SET company_name=$1, keywords=$2, exclude_keywords=$3, categories=$4, buyer_terms=$5, notes=$6, updated_at=now()`,
        [String(b.company_name || '').slice(0, 120), lines(b.keywords), lines(b.exclude_keywords), cats, lines(b.buyer_terms), String(b.notes || '').slice(0, 1000)]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'profile.updated', {});
    });
    const r = await matchTenant(u.tenant_id);
    return reply.redirect(`/app?m=${encodeURIComponent(`Profile saved. ${r.matched || 0} matching open tender(s) found.`)}`);
  });

  app.get('/app/documents', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const docs = (await withTenant(u.tenant_id, (c) => c.query('SELECT * FROM vault_docs ORDER BY expires_on NULLS LAST'))).rows;
    const today = new Date().toISOString().slice(0, 10);
    const rows = docs.map((d) => { const exp = d.expires_on ? String(d.expires_on).slice(0, 10) : null; const cls = exp && exp < today ? 'bad' : ''; return `<tr><td>${esc(d.doc_type)}</td><td>${esc(d.title)}<div class="mut">${esc(d.reference)}</div></td><td class="${cls}">${exp ? esc(exp) + (exp < today ? ' (expired)' : '') : 'no expiry'}</td>
      <td><form method="post" action="/app/documents/${d.id}/delete">${csrf(u)}<button class="sec">Remove</button></form></td></tr>`; }).join('');
    return render(reply, u, 'Documents', `<h1>Document tracker</h1><p class="mut">HI tracks what you have and when it expires. In this version it stores details only, not the files themselves.</p>
      <div class="card"><table><tr><th>Type</th><th>Title</th><th>Expires</th><th></th></tr>${rows || '<tr><td colspan="4" class="mut">No documents recorded yet.</td></tr>'}</table></div>
      <form method="post" class="card">${csrf(u)}<b>Add a document</b><label>Type</label><select name="doc_type">${DOC_TYPES.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
      <label>Title</label><input name="title" required maxlength="120"><label>Reference number (optional)</label><input name="reference" maxlength="80"><label>Expiry date (optional)</label><input name="expires_on" type="date"><p><button>Add</button></p></form>`, flashOf(req));
  });
  app.post('/app/documents', { preHandler: guard }, async (req, reply) => {
    const u = req.user, b = req.body || {};
    if (!DOC_TYPES.includes(b.doc_type) || !b.title) return reply.code(400).send('bad input');
    const exp = /^\d{4}-\d{2}-\d{2}$/.test(b.expires_on || '') ? b.expires_on : null;
    await withTenant(u.tenant_id, async (c) => {
      await c.query("INSERT INTO vault_docs (tenant_id, doc_type, title, reference, expires_on) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4)", [b.doc_type, String(b.title).slice(0, 120), String(b.reference || '').slice(0, 80), exp]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'document.added', { doc_type: b.doc_type });
    });
    return reply.redirect('/app/documents?m=' + encodeURIComponent('Added.'));
  });
  app.post('/app/documents/:id/delete', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(u.tenant_id, async (c) => { await c.query('DELETE FROM vault_docs WHERE id=$1', [req.params.id]); await audit(c, u.tenant_id, `user:${u.user_id}`, 'document.removed', { id: req.params.id }); });
    return reply.redirect('/app/documents?m=' + encodeURIComponent('Removed.'));
  });

  app.get('/app/approvals', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = (await withTenant(u.tenant_id, (c) => c.query('SELECT a.*, b.body_text, (SELECT j.screenshots->-1->>\'img\' FROM browser_jobs j WHERE j.id = (a.payload->>\'job_id\')::uuid) shot FROM approvals a LEFT JOIN briefs b ON b.id = (a.payload->>\'brief_id\')::uuid ORDER BY a.created_at DESC LIMIT 50'))).rows;
    const html = rows.map((a) => `<div class="card"><div class="row"><b>${esc(a.summary)}</b><span class="tag">${esc(a.status)}</span></div><div class="mut">Proposed by ${esc(a.proposed_by)} on ${fdate(a.created_at)}</div>
      ${a.shot && /^[A-Za-z0-9+/=]+$/.test(a.shot) ? `<img alt="What the browser sees now" style="max-width:100%;border:1px solid var(--line);border-radius:8px" src="data:image/jpeg;base64,${a.shot}">` : ''}${(a.body_text || a.payload?.body) ? `<pre>${esc(a.body_text || a.payload.body)}</pre>` : ''}${a.status === 'proposed' ? `<form method="post" action="/app/approvals/${a.id}">${csrf(u)}<p>${a.kind.startsWith('browser_') ? 'Approving lets the isolated browser continue.' : `This will email the text above to <b>${esc(u.email)}</b> only.`}</p><button name="decision" value="approve">Approve and send</button> <button name="decision" value="reject" class="sec">Reject</button></form>` : ''}</div>`).join('');
    return render(reply, u, 'Approvals', `<h1>Approval queue</h1><p class="mut">HI proposes. You decide. Nothing leaves your account without your approval here.</p>${html || '<div class="card mut">Nothing waiting.</div>'}`, flashOf(req));
  });
  app.post('/app/approvals/:id', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send('bad id');
    const r = await decideApproval({ tenantId: u.tenant_id, userId: u.user_id, userEmail: u.email, approvalId: req.params.id, decision: req.body?.decision, fetchImpl });
    return reply.redirect('/app/approvals?m=' + encodeURIComponent(r.error ? r.error : r.reason ? `${r.status}: ${r.reason}` : r.status));
  });

  app.get('/app/briefs', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = (await withTenant(u.tenant_id, (c) => c.query('SELECT id, subject, status, created_at FROM briefs ORDER BY created_at DESC LIMIT 30'))).rows;
    return render(reply, u, 'Briefs', `<h1>Briefs</h1><div class="card"><table><tr><th>Date</th><th>Subject</th><th>Status</th></tr>${rows.map((b) => `<tr><td>${fdate(b.created_at)}</td><td>${esc(b.subject)}</td><td>${esc(b.status)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">No briefs yet.</td></tr>'}</table></div>
      <form method="post" action="/app/briefs/now" class="card">${csrf(u)}<p>Want one now? HI will draft it and put it in your approval queue.</p><button>Draft a brief now</button></form>`, flashOf(req));
  });
  app.post('/app/briefs/now', { preHandler: guard }, async (req, reply) => {
    const { buildBrief } = await import('./core.js');
    const r = await buildBrief(req.user.tenant_id);
    return reply.redirect(r.approval_id ? '/app/approvals?m=' + encodeURIComponent('Brief drafted. Review it below.') : '/app/briefs?m=' + encodeURIComponent(`No brief: ${r.skipped}`));
  });

  app.get('/app/audit', { preHandler: guard }, async (req, reply) => {
    const rows = (await withTenant(req.user.tenant_id, (c) => c.query('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 100'))).rows;
    return render(reply, req.user, 'Audit log', `<h1>Audit log</h1><div class="card"><table><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr>${rows.map((r) => `<tr><td>${fdate(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td class="mut">${esc(JSON.stringify(r.detail))}</td></tr>`).join('')}</table></div>`);
  });

  app.get('/app/settings', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    return render(reply, u, 'Settings', `<h1>Settings</h1>
      <div class="card"><b>Emergency stop for your account</b><p class="mut">${u.paused ? 'Your account is paused. HI will not match, draft or send anything.' : 'Pause stops all matching, drafting and sending for your account immediately.'}</p>
      <form method="post" action="/app/settings/pause">${csrf(u)}<button name="paused" value="${u.paused ? 'false' : 'true'}" class="${u.paused ? '' : 'danger'}">${u.paused ? 'Resume' : 'Pause my account'}</button></form></div>
      <div class="card"><b>Connections</b><ul><li>eTenders (National Treasury open data): active</li><li>Email brief delivery: ${mailConfigured() ? 'configured' : 'not configured'}</li><li>AI fit notes: ${modelEnabled() ? 'on (text is redacted first; notes are marked unverified)' : 'off'}</li><li>WhatsApp: not available in this version</li></ul></div>`, flashOf(req));
  });
  app.post('/app/settings/pause', { preHandler: guard }, async (req, reply) => {
    const u = req.user, paused = req.body?.paused === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET paused=$2 WHERE id=$1', [u.tenant_id, paused]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, paused ? 'tenant.paused' : 'tenant.resumed', {});
    if (paused) await withTenant(u.tenant_id, (c) => c.query("UPDATE approvals SET status='cancelled' WHERE status='proposed'"));
    return reply.redirect('/app/settings?m=' + encodeURIComponent(paused ? 'Paused.' : 'Resumed.'));
  });


  // ---------- Agent platform ----------
  const mdLite = (t) => esc(String(t).replace(/<br\s*\/?>/gi, '\n').replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '')).replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const srcList = (src) => (src || []).length ? `<div class="mut">Sources: ${(src).map((x, i) => `[${i + 1}] <a href="${safeUrl(x.url)}" rel="noopener noreferrer" target="_blank">${esc(String(x.title || x.url).slice(0, 80))}</a>`).join(' &nbsp; ')}</div>` : '';
  const uuidOk = (x) => /^[0-9a-f-]{36}$/i.test(String(x || ''));

  app.get('/app/agent', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    await ensureDefaultAgent(u.tenant_id);
    const d = await withTenant(u.tenant_id, async (c) => {
      const agents = (await c.query('SELECT id, name, persona FROM agents ORDER BY created_at')).rows;
      const agent = agents.find((a) => a.id === req.query.agent) || agents[0];
      const convs = (await c.query('SELECT id, title, created_at FROM conversations WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 15', [agent.id])).rows;
      const conv = uuidOk(req.query.c) ? convs.find((x) => x.id === req.query.c) : null;
      const msgs = conv ? (await c.query('SELECT role, content, sources, steps, created_at FROM messages WHERE conversation_id=$1 ORDER BY id', [conv.id])).rows : [];
      return { agents, agent, convs, conv, msgs };
    });
    const thread = d.msgs.map((m) => `<div class="card"><div class="mut">${m.role === 'user' ? 'You' : esc(d.agent.name)}</div><div>${mdLite(m.content)}</div>${m.role === 'assistant' ? srcList(m.sources) : ''}${(m.steps || []).filter((x) => x.type === 'tool').length ? `<div class="mut">Used: ${(m.steps).filter((x) => x.type === 'tool').map((x) => esc(x.name)).join(', ')}</div>` : ''}</div>`).join('');
    return render(reply, u, 'Agent', `<h1>${esc(d.agent.name)}</h1>
      <p class="mut">${d.agents.map((a) => `<a href="/app/agent?agent=${a.id}">${esc(a.name)}</a>`).join(' | ')} ${agentModelEnabled() ? '' : '<span class="bad"> (AI model not configured)</span>'}</p>
      ${thread || '<div class="card mut">Ask me to research something, remember a fact about your business, find tenders, or schedule a recurring job. I draft; you approve anything that leaves your account.</div>'}
      <form method="post" action="/app/agent/message" class="card">${csrf(u)}<input type="hidden" name="agent" value="${d.agent.id}"><input type="hidden" name="c" value="${d.conv ? d.conv.id : ''}">
        <label>Message ${esc(d.agent.name)}</label><textarea name="text" rows="3" maxlength="4000" required></textarea><p><button>Send</button></p></form>
      <div class="card"><b>Recent conversations</b><ul>${d.convs.map((x) => `<li><a href="/app/agent?agent=${d.agent.id}&c=${x.id}">${esc(x.title)}</a> <span class="mut">${fdate(x.created_at)}</span></li>`).join('') || '<li class="mut">None yet</li>'}</ul></div>
      <form method="post" action="/app/agent/new" class="card">${csrf(u)}<b>Add another named agent</b><label>Name</label><input name="name" required maxlength="40"><label>What is this agent for?</label><input name="persona" maxlength="300" placeholder="e.g. Handles supplier research and quotes"><p><button class="sec">Create agent</button></p></form>`, flashOf(req));
  });
  const msgLimit = makeLimiter(30, 60 * 60 * 1000);
  app.post('/app/agent/message', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const { agent, c: conv, text } = req.body || {};
    if (!uuidOk(agent) || !String(text || '').trim()) return reply.redirect('/app/agent?m=' + encodeURIComponent('Write a message first.'));
    if (!msgLimit(u.tenant_id)) return reply.redirect('/app/agent?m=' + encodeURIComponent('Too many messages this hour.'));
    const r = await runAgent({ tenantId: u.tenant_id, userEmail: u.email, agentId: agent, conversationId: uuidOk(conv) ? conv : null, userText: String(text).trim(), llm, fetchImpl, lookup });
    if (r.error) return reply.redirect(`/app/agent?agent=${agent}&m=` + encodeURIComponent(r.error));
    return reply.redirect(`/app/agent?agent=${agent}&c=${r.conversationId}`);
  });
  app.post('/app/agent/new', { preHandler: guard }, async (req, reply) => {
    const u = req.user; const name = String(req.body?.name || '').trim().slice(0, 40);
    if (!name) return reply.redirect('/app/agent?m=' + encodeURIComponent('Give the agent a name.'));
    try {
      const a = await withTenant(u.tenant_id, async (c) => {
        if ((await c.query('SELECT count(*)::int n FROM agents')).rows[0].n >= 5) return null;
        const r = (await c.query("INSERT INTO agents (tenant_id, name, persona) VALUES (current_setting('app.tenant_id')::uuid,$1,$2) RETURNING id", [name, String(req.body?.persona || '').slice(0, 300)])).rows[0];
        await audit(c, u.tenant_id, `user:${u.user_id}`, 'agent.created', { agent_id: r.id }); return r;
      });
      if (!a) return reply.redirect('/app/agent?m=' + encodeURIComponent('Limit of 5 agents reached.'));
      return reply.redirect(`/app/agent?agent=${a.id}`);
    } catch (e) { return reply.redirect('/app/agent?m=' + encodeURIComponent('That name is already used.')); }
  });

  app.get('/app/tasks', { preHandler: guard }, async (req, reply) => {
    const u = req.user; await ensureDefaultAgent(u.tenant_id);
    const d = await withTenant(u.tenant_id, async (c) => ({
      tasks: (await c.query('SELECT t.*, a.name agent_name FROM tasks t JOIN agents a ON a.id=t.agent_id ORDER BY t.created_at DESC LIMIT 50')).rows,
      runs: (await c.query("SELECT r.id, r.status, r.result, r.sources, r.created_at, t.title FROM runs r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.task_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 10")).rows,
      agents: (await c.query('SELECT id, name FROM agents ORDER BY created_at')).rows }));
    return render(reply, u, 'Tasks', `<h1>Scheduled tasks</h1>
      <div class="card"><table><tr><th>Task</th><th>Agent</th><th>Runs</th><th>Next</th><th>Status</th><th></th></tr>${d.tasks.map((t) => `<tr><td>${esc(t.title)}<div class="mut">${esc(t.instruction.slice(0, 120))}</div></td><td>${esc(t.agent_name)}</td><td>${t.interval_minutes ? `every ${t.interval_minutes} min` : 'once'}</td><td>${fdate(t.next_run_at)}</td><td>${esc(t.status)}</td>
        <td>${t.status !== 'done' ? `<form method="post" action="/app/tasks/${t.id}/toggle">${csrf(u)}<button class="sec">${t.status === 'active' ? 'Pause' : 'Resume'}</button></form>` : ''}<form method="post" action="/app/tasks/${t.id}/delete">${csrf(u)}<button class="sec">Delete</button></form></td></tr>`).join('') || '<tr><td colspan="6" class="mut">No tasks yet. Ask your agent to schedule one, or add one below.</td></tr>'}</table></div>
      <form method="post" action="/app/tasks" class="card">${csrf(u)}<b>New task</b><label>Title</label><input name="title" required maxlength="120"><label>What should the agent do each time?</label><textarea name="instruction" rows="3" maxlength="2000" required></textarea>
        <label>Agent</label><select name="agent">${d.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><label>Repeat every (minutes, 60 or more, blank for once)</label><input name="every" type="number" min="60"><label>First run in (minutes)</label><input name="first" type="number" min="1" value="60"><p><button>Schedule</button></p></form>
      <h2>Recent runs</h2>${d.runs.map((r) => `<div class="card"><div class="row"><b>${esc(r.title || 'Task')}</b><span class="tag">${esc(r.status)}</span></div><div class="mut">${fdate(r.created_at)}</div><div>${mdLite((r.result || '').slice(0, 1500))}</div>${srcList(r.sources)}</div>`).join('') || '<div class="card mut">No runs yet.</div>'}`, flashOf(req));
  });
  app.post('/app/tasks', { preHandler: guard }, async (req, reply) => {
    const u = req.user, b = req.body || {};
    if (!uuidOk(b.agent) || !String(b.title || '').trim() || !String(b.instruction || '').trim()) return reply.redirect('/app/tasks?m=' + encodeURIComponent('Title and instruction are required.'));
    const every = b.every ? Math.max(60, Math.min(43200, Number(b.every) || 60)) : null;
    const first = Math.max(1, Math.min(525600, Number(b.first) || 60));
    const ok = await withTenant(u.tenant_id, async (c) => {
      if ((await c.query("SELECT count(*)::int n FROM tasks WHERE status='active'")).rows[0].n >= 10) return false;
      const r = (await c.query("INSERT INTO tasks (tenant_id, agent_id, title, instruction, interval_minutes, next_run_at, created_by) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4, now() + ($5 || ' minutes')::interval,$6) RETURNING id", [b.agent, String(b.title).slice(0, 120), String(b.instruction).slice(0, 2000), every, String(first), `user:${u.user_id}`])).rows[0];
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'task.scheduled', { task_id: r.id, every_minutes: every }); return true;
    });
    return reply.redirect('/app/tasks?m=' + encodeURIComponent(ok ? 'Scheduled.' : 'Limit of 10 active tasks reached.'));
  });
  app.post('/app/tasks/:id/toggle', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, (c) => c.query("UPDATE tasks SET status = CASE status WHEN 'active' THEN 'paused' ELSE 'active' END, next_run_at = CASE WHEN status='paused' THEN now() + interval '5 minutes' ELSE next_run_at END WHERE id=$1 AND status<>'done'", [req.params.id]));
    return reply.redirect('/app/tasks');
  });
  app.post('/app/tasks/:id/delete', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => { await c.query('DELETE FROM tasks WHERE id=$1', [req.params.id]); await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'task.deleted', { task_id: req.params.id }); });
    return reply.redirect('/app/tasks?m=' + encodeURIComponent('Deleted.'));
  });

  app.get('/app/memory', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = (await withTenant(u.tenant_id, (c) => c.query('SELECT id, kind, content, created_at FROM memories ORDER BY created_at DESC LIMIT 100'))).rows;
    return render(reply, u, 'Memory', `<h1>What your agents remember</h1><p class="mut">You can see and delete everything saved here. Core memories are always in the agent's mind; archival ones are searched when relevant.</p>
      <form method="post" action="/app/memory" class="card">${csrf(u)}<label>Add a memory</label><input name="content" required maxlength="1000"><label>Type</label><select name="kind"><option value="core">core (always remembered)</option><option value="archival">archival</option></select><p><button>Save</button></p></form>
      <div class="card"><table><tr><th>When</th><th>Type</th><th>Memory</th><th></th></tr>${rows.map((m) => `<tr><td>${fdate(m.created_at)}</td><td>${esc(m.kind)}</td><td>${esc(m.content)}</td><td><form method="post" action="/app/memory/${m.id}/delete">${csrf(u)}<button class="sec">Delete</button></form></td></tr>`).join('') || '<tr><td colspan="4" class="mut">Nothing saved yet.</td></tr>'}</table></div>`, flashOf(req));
  });
  app.post('/app/memory', { preHandler: guard }, async (req, reply) => {
    const u = req.user, content = String(req.body?.content || '').trim().slice(0, 1000);
    if (content) await withTenant(u.tenant_id, async (c) => { await c.query("INSERT INTO memories (tenant_id, kind, content) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [req.body?.kind === 'core' ? 'core' : 'archival', content]); await audit(c, u.tenant_id, `user:${u.user_id}`, 'memory.saved', {}); });
    return reply.redirect('/app/memory?m=' + encodeURIComponent('Saved.'));
  });
  app.post('/app/memory/:id/delete', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => { await c.query('DELETE FROM memories WHERE id=$1', [req.params.id]); await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'memory.deleted', {}); });
    return reply.redirect('/app/memory?m=' + encodeURIComponent('Deleted.'));
  });


  // ---------- Browser jobs ----------
  app.get('/app/browser', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const jobs = (await withTenant(u.tenant_id, (c) => c.query('SELECT id, start_url, goal, mode, status, result, step_count, screenshots, created_at, finished_at FROM browser_jobs ORDER BY created_at DESC LIMIT 15'))).rows;
    return render(reply, u, 'Browser', `<h1>Browser tasks</h1><p class="mut">Each task runs in its own fresh cloud browser that is destroyed afterwards. Nothing starts until you approve it in Approvals, and any final submit needs a second approval. Passwords, card numbers and codes are never entered by HI.</p>
      ${jobs.map((j) => `<div class="card"><div class="row"><b>${esc(new URL(j.start_url).hostname)}</b><span class="tag">${esc(j.status)} - ${esc(j.mode)}</span></div><div class="mut">${esc(j.goal.slice(0, 200))}</div>${j.result ? `<div>${mdLite(j.result)}</div>` : ''}
        ${(j.screenshots || []).slice(-3).map((s) => `<img alt="Browser step ${s.step + 1}" style="max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:8px" src="data:image/jpeg;base64,${/^[A-Za-z0-9+/=]+$/.test(s.img) ? s.img : ''}">`).join('')}</div>`).join('') || '<div class="card mut">No browser tasks yet. Ask your agent to open a site and do something on it.</div>'}`, flashOf(req));
  });
  const jsonBig = { bodyLimit: 700 * 1024 };
  app.post('/internal/browser/start', async (req, reply) => {
    const { job_id, token } = req.body || {};
    const tenantId = (await withSystem((c) => c.query('SELECT browser_job_tenant($1,$2) t', [String(job_id), require_hash(token)]))).rows[0]?.t;
    if (!tenantId) return reply.code(401).send({ error: 'invalid job token' });
    const j = await withTenant(tenantId, async (c) => { await c.query("UPDATE browser_jobs SET status='running' WHERE id=$1 AND status='queued'", [job_id]); return (await c.query('SELECT start_url FROM browser_jobs WHERE id=$1', [job_id])).rows[0]; });
    return { start_url: j.start_url };
  });
  app.post('/internal/browser/step', jsonBig, async (req, reply) => {
    const b = req.body || {}; const r = await browserStep({ jobId: String(b.job_id), token: b.token, observation: b.observation, screenshot: b.screenshot, llm, lookup });
    return reply.code(r.status).send(r.body);
  });
  app.post('/internal/browser/poll', async (req, reply) => { const b = req.body || {}; const r = await browserPoll({ jobId: String(b.job_id), token: b.token }); return reply.code(r.status).send(r.body); });
  app.post('/internal/browser/finish', jsonBig, async (req, reply) => {
    const b = req.body || {};
    const tenantId = (await withSystem((c) => c.query('SELECT browser_job_tenant($1,$2) t', [String(b.job_id), require_hash(b.token)]))).rows[0]?.t;
    if (!tenantId) return reply.code(401).send({ error: 'invalid job token' });
    await withTenant(tenantId, async (c) => {
      const j = (await c.query('SELECT screenshots, status FROM browser_jobs WHERE id=$1 FOR UPDATE', [b.job_id])).rows[0];
      const shots = j.screenshots; if (typeof b.screenshot === 'string' && b.screenshot.length < 400000 && /^[A-Za-z0-9+/=]+$/.test(b.screenshot)) { if (shots.length >= 6) shots.shift(); shots.push({ step: 99, url: String(b.observation?.url || '').slice(0, 300), img: b.screenshot }); }
      await c.query("UPDATE browser_jobs SET screenshots=$2, status=CASE WHEN status IN ('running','queued','awaiting_approval') THEN 'done' ELSE status END, result=coalesce(result,'The browser session ended.'), finished_at=coalesce(finished_at, now()) WHERE id=$1", [b.job_id, JSON.stringify(shots)]);
    });
    return { ok: true };
  });


  // ---------- WhatsApp ----------
  app.post('/internal/wa/inbound', async (req, reply) => {
    if (!secretEq(req.headers['x-wa-secret'], process.env.WA_INBOUND_SECRET)) return reply.code(401).send({ error: 'unauthorised' });
    const b = req.body || {};
    const r = await handleInbound({ to: b.to, from: b.from, text: b.text, externalId: b.id ? String(b.id).slice(0, 80) : null, llm, fetchImpl, lookup, adapter: makeAdapter(fetchImpl) });
    return reply.code(r.status || 200).send(r);
  });
  app.get('/app/whatsapp', { preHandler: guard }, async (req, reply) => {
    const u = req.user; await ensureDefaultAgent(u.tenant_id);
    const d = await withTenant(u.tenant_id, async (c) => ({
      channels: (await c.query('SELECT number, engine, status FROM wa_channels')).rows,
      contacts: (await c.query('SELECT id, phone, name FROM wa_contacts ORDER BY created_at')).rows,
      msgs: (await c.query('SELECT phone, direction, body, status, created_at FROM wa_messages ORDER BY id DESC LIMIT 30')).rows }));
    return render(reply, u, 'WhatsApp', `<h1>WhatsApp</h1><p class="mut">Your agent answers WhatsApp messages from the people you add here, and only replies. It never starts a conversation, and anyone not on this list is ignored. ${d.channels.length ? '' : 'No WhatsApp number is linked yet; a number is linked by NahaLabs when you are ready.'}</p>
      <div class="card"><b>Linked number</b><ul>${d.channels.map((x) => `<li>${esc(x.number)} (${esc(x.engine)}, ${esc(x.status)})</li>`).join('') || '<li class="mut">None yet</li>'}</ul></div>
      <div class="card"><b>People HI may reply to</b><table>${d.contacts.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td><form method="post" action="/app/whatsapp/contacts/${x.id}/delete">${csrf(u)}<button class="sec">Remove</button></form></td></tr>`).join('') || '<tr><td class="mut">No contacts yet</td></tr>'}</table>
        <form method="post" action="/app/whatsapp/contacts">${csrf(u)}<label>Name</label><input name="name" maxlength="60"><label>Phone number with country code, e.g. 27821234567</label><input name="phone" required><p><button>Add contact</button></p></form></div>
      <div class="card"><b>Recent messages</b><table>${d.msgs.map((m) => `<tr><td>${fdate(m.created_at)}</td><td>${m.direction === 'in' ? 'from' : 'to'} ${esc(m.phone)}</td><td>${esc(m.body.slice(0, 200))}</td><td>${esc(m.status)}</td></tr>`).join('') || '<tr><td class="mut">Nothing yet</td></tr>'}</table></div>`, flashOf(req));
  });
  app.post('/app/whatsapp/contacts', { preHandler: guard }, async (req, reply) => {
    const u = req.user, phone = normalisePhone(req.body?.phone);
    if (!/^[0-9]{8,15}$/.test(phone)) return reply.redirect('/app/whatsapp?m=' + encodeURIComponent('Enter the number with country code, digits only.'));
    await withTenant(u.tenant_id, async (c) => { await c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,$1,$2) ON CONFLICT DO NOTHING", [phone, String(req.body?.name || '').slice(0, 60)]); await audit(c, u.tenant_id, `user:${u.user_id}`, 'wa.contact_added', {}); });
    return reply.redirect('/app/whatsapp?m=' + encodeURIComponent('Added.'));
  });
  app.post('/app/whatsapp/contacts/:id/delete', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => { await c.query('DELETE FROM wa_contacts WHERE id=$1', [req.params.id]); await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'wa.contact_removed', {}); });
    return reply.redirect('/app/whatsapp?m=' + encodeURIComponent('Removed.'));
  });

  // ---------- Internal (scheduler) ----------
  const cronAuth = async (req, reply) => { if (!secretEq(req.headers['x-cron-secret'], process.env.CRON_SECRET)) { reply.code(401).send({ error: 'unauthorised' }); return reply; } };
  app.post('/internal/run', { preHandler: cronAuth }, async (req) => {
    const job = req.query.job || 'all';
    if (await emergencyStopped()) return { skipped: 'emergency stop is on' };
    const out = {};
    if (job === 'ingest' || job === 'all') out.ingest = await ingest({ days: Number(req.query.days || 3), fetchImpl });
    if (job === 'match' || job === 'all') out.match = await matchAllTenants();
    if (job === 'brief' || job === 'all') out.brief = await buildBriefsForAll();
    if (job === 'tasks' || job === 'all') out.tasks = await runDueTasks({ llm, fetchImpl, lookup });
    return out;
  });
  app.post('/internal/stop', { preHandler: cronAuth }, async (req) => { await setEmergencyStop(req.query.on !== 'false'); return { emergency_stop: req.query.on !== 'false' }; });

  app.addHook('onClose', async () => { await closePool(); });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp({ logger: true });
  await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
}
