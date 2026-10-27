import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import { timingSafeEqual, createHash, createHmac } from 'node:crypto';
const require_hash = (t) => createHash('sha256').update(String(t || '')).digest('hex');
import { withTenant, withSystem, audit, auditFor, closePool, assertSchemaReady } from './db.js';
import { hashPassword, verifyPassword, newToken, tokenHash, makeLimiter } from './auth.js';
import { page, esc, fdate, safeUrl, drivePage } from './views.js';
import { estateAttention } from './attention.js';
import { ingest } from './ingest.js';
import { runViewingReminders, runDocExpiryReminders } from './reminders.js';
import { matchTenant, matchAllTenants } from './match.js';
import { buildBriefsForAll, decideApproval, setEmergencyStop, emergencyStopped, vaultAlerts } from './core.js';
import { explainFit, modelEnabled } from './gateway.js';
import { mailConfigured, sendMail } from './mail.js';
import { handleInbound, makeAdapter, normalisePhone, parseMetaWebhook } from './whatsapp.js';
import { handleStripeWebhook, fmtMoney } from './stripe.js';
import { browserStep, browserPoll } from './browser.js';
import { runAgent, runDueTasks, ensureDefaultAgent, toolLabel } from './agent.js';
import { splitDump, activeList, startDump, MAX_DUMP_CHARS } from './dump.js';
import { buildMorningBriefs } from './brief.js';
import { chat as defaultChat, agentModelEnabled } from './gateway.js';
import { registerApi, newApiKey } from './api.js';
import { ensureBuiltinSkills } from './skills.js';
import { voiceConfigured, voiceMaxBytes, transcribe, speak } from './voice.js';
import { buildXlsx, XLSX_MIME } from './xlsx.js';
import { authUrlFor, connectAccount, providerConfigured, PROVIDERS, integrationsConfigured, enc } from './integrations.js';
import { saveUpload, listUploads, uploadTypeFor, tenantUploadQuota, UPLOAD_TYPES } from './uploads.js';
import { createHash as _ch } from 'node:crypto';

const COOKIE = 'hi_session';

// PWA: manifest, service worker, icons (static, no auth)
import { readFileSync } from 'node:fs';
const STATIC = {
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
  '/drive.js': ['public/drive.js', 'text/javascript; charset=utf-8'],
  '/talk.js': ['public/talk.js', 'text/javascript; charset=utf-8'],
  '/boot.js': ['public/boot.js', 'text/javascript; charset=utf-8'],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
  '/home-app.jpg': ['public/home-app.jpg', 'image/jpeg'],
  '/home-estate.jpg': ['public/home-estate.jpg', 'image/jpeg'],
  '/icons/icon-192.png': ['public/icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['public/icons/icon-512.png', 'image/png'],
  '/icons/maskable-512.png': ['public/icons/maskable-512.png', 'image/png'],
};
const secretEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
const csrfFor = (token) => tokenHash(token + (process.env.SESSION_SECRET || 'dev-only')).slice(0, 40);
const lines = (s) => String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean).slice(0, 40).map((x) => x.slice(0, 80));
const STATUSES = ['new', 'saved', 'dismissed', 'applied', 'won', 'lost'];
const DOC_TYPES = ['CSD supplier report', 'Tax compliance status (SARS)', 'B-BBEE certificate or affidavit', 'CIPC registration', 'Bank confirmation letter', 'FICA - ID document', 'FICA - proof of address', 'PPRA Fidelity Fund Certificate', 'Other'];

export async function buildApp({ fetchImpl = fetch, logger = false, llm = defaultChat, lookup } = {}) {
  // Refuse to boot in production without the secrets sessions and cron auth depend on. Both are proven set on the live service (logins and cron runs work).
  if (process.env.NODE_ENV === 'production') {
    for (const k of ['SESSION_SECRET', 'CRON_SECRET']) {
      if (!process.env[k] || process.env[k].length < 16) throw new Error(`${k} must be set to at least 16 characters in production`);
    }
  }
  const app = Fastify({ logger, trustProxy: 1, bodyLimit: 100 * 1024 });  // trust one proxy hop (Render's edge); 'true' would trust the whole X-Forwarded-For chain and let clients spoof IPs past rate limits
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  await app.register(cookie);
  for (const t of ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'application/octet-stream']) {
    app.addContentTypeParser(t, { parseAs: 'buffer' }, (req, body, done) => done(null, body));
  }
  registerApi(app, { llm, fetchImpl, lookup });
  const loginLimit = makeLimiter(8, 10 * 60 * 1000);
  const signupLimit = makeLimiter(Number(process.env.SIGNUP_RATE_MAX || 5), 60 * 60 * 1000);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
    if (req.url.startsWith('/app')) reply.header('cache-control', 'no-store');
  });

  async function sessionOf(req) {
    const token = req.cookies?.[COOKIE];
    if (!token) return null;
    const r = await withSystem((c) => c.query(
      `SELECT u.id user_id, u.email, u.tenant_id, t.name tenant_name, t.paused, t.morning_brief_auto, t.viewing_reminders_auto, t.document_reminders_auto, t.stripe_notifications_auto
       FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash(token)]));
    const u = r.rows[0];
    return u ? { ...u, csrf: csrfFor(token) } : null;
  }
  // Notification feed: user-meaningful events read straight from audit_log
  // (real recorded events only - nothing is synthesized for the feed).
  const NOTIF_ACTIONS = ['stripe.payment_received', 'wa.message_received', 'estate.viewing_requested', 'wa.reply_blocked', 'social.post_blocked', 'ads.campaign_blocked', 'ads.chain_failed', 'social.post_filed', 'ads.campaign_filed'];
  const notifUnread = (tenantId, userId) => withTenant(tenantId, async (c) => {
    const last = (await c.query('SELECT last_read_id FROM notification_reads WHERE user_id=$1', [userId])).rows[0]?.last_read_id || 0;
    return (await c.query('SELECT count(*)::int n FROM audit_log WHERE id > $1 AND action = ANY($2)', [last, NOTIF_ACTIONS])).rows[0].n;
  });
  const notifText = (a) => {
    const d = a.detail || {};
    if (a.action === 'stripe.payment_received') return `Payment received${d.amount_cents != null ? `: ${esc(String(d.currency || ''))} ${(Number(d.amount_cents) / 100).toFixed(2)}` : ''}`;
    if (a.action === 'wa.message_received') return `WhatsApp message from ${esc(String(d.phone || 'a contact'))}`;
    if (a.action === 'estate.viewing_requested') return 'A viewing was requested';
    // User-facing text stays plain language: internal flags, provider IDs and raw
    // diagnostics stay in the audit log, never in the UI.
    if (a.action === 'ads.chain_failed') return 'Setting up an ad draft did not finish. The technical details are recorded in the audit log for review.';
    if (a.action === 'social.post_filed' || a.action === 'ads.campaign_filed') return 'A draft you approved was filed - nothing was sent because that platform is not switched on yet.';
    if (a.action === 'wa.reply_blocked') return 'A WhatsApp reply was not sent. The details are recorded in the audit log.';
    if (a.action === 'social.post_blocked') return 'A social post was not published. The details are recorded in the audit log.';
    if (a.action === 'ads.campaign_blocked') return 'An ad draft was not submitted. The details are recorded in the audit log.';
    if (a.action.endsWith('_blocked')) return 'HI was blocked from acting. The details are recorded in the audit log.';
    return esc(a.action);
  };
  const guard = async (req, reply) => {
    const s = await sessionOf(req);
    if (!s) { reply.redirect('/login'); return reply; }
    if (req.method === 'GET' && req.url.startsWith('/app')) { try { s.notif_unread = await notifUnread(s.tenant_id, s.user_id); } catch { s.notif_unread = 0; } }
    const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/');
    if (req.method === 'POST' && !isMultipart && !secretEq(req.body?.csrf, s.csrf)) { reply.code(403).send('Bad request token'); return reply; }
    req.user = s;
  };
  const render = (reply, user, title, body, flash) => reply.type('text/html').send(page({ title, user, body, flash }));
  const csrf = (u) => `<input type="hidden" name="csrf" value="${esc(u.csrf)}">`;
  const flashOf = (req) => req.query?.m ? String(req.query.m).slice(0, 160) : null;

  for (const [p, [file, mime]] of Object.entries(STATIC)) {

    app.get(p, (req, reply) => {

      reply.header('Cache-Control', p === '/sw.js' ? 'no-cache' : 'public, max-age=86400');

      if (p === '/sw.js') reply.header('Service-Worker-Allowed', '/');

      return reply.type(mime).send(readFileSync(file));

    });

  }


  app.get('/healthz', async () => ({ ok: true }));
  app.get('/healthz/db', async (req, reply) => { try { const r = await withSystem((c) => c.query('SELECT count(*)::int n FROM tenants')); return { ok: true, db: 'ok' }; } catch (e) { return reply.code(503).send({ ok: false, db: 'down' }); } });

  app.get('/', async (req, reply) => {
    const s = await sessionOf(req);
    if (s) return reply.redirect('/app/agent');
    return render(reply, null, 'HI - the app that does the desk work', `
      <section class="hero">
        <h1>HI does the desk work.</h1>
        <p class="lede">Built for South African estate agencies: it tracks your deals, viewings and follow-ups, drafts your client emails, remembers your business and works on a schedule. You approve everything before anything goes out.</p>
        <p class="cta"><a class="btn" href="/signup">Start free</a> <a class="btn sec" href="/login">Sign in</a></p>
        <div class="shot"><img src="/home-estate.jpg" alt="The HI Estate page with sample deals, viewings and follow-ups for an estate agency - sample data"></div>
      </section>
      <section class="feat">
        <div class="card"><b>Tracks deals</b><br>Properties, contacts, viewings and deal stages, with next actions kept in view.</div>
        <div class="card"><b>Drafts for you</b><br>Emails, briefs and replies, ready to check. Nothing sends without your approval.</div>
        <div class="card"><b>Remembers</b><br>Your clients, your pricing, your documents - it keeps what matters and uses it.</div>
        <div class="card"><b>Works on schedule</b><br>Recurring jobs and a morning brief, reported back to you.</div>
      </section>
      <p class="mut" style="text-align:center;max-width:560px;margin:22px auto 0">Honest limits: HI drafts and proposes - you approve everything that leaves your account. It can be wrong, and it says so when it cannot verify something.</p>`);
  });

  app.get('/signup', async (req, reply) => render(reply, null, 'Create account', `
    <div class="auth"><h1>Create your account</h1><form method="post" class="card">
    <label>Company name</label><input name="company" required maxlength="120">
    <label>Email</label><input name="email" type="email" required>
    <label>Password (12+ characters)</label><input name="password" type="password" minlength="12" required autocomplete="new-password">
    <input name="website" type="text" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <p><button>Create account</button></p></form><p class="mut" style="text-align:center">Already have an account? <a href="/login">Sign in</a></p></div>`, flashOf(req)));

  app.post('/signup', async (req, reply) => {
    if (!signupLimit(req.ip)) return reply.code(429).send('Too many attempts. Please wait a while and try again.');
    const { company, email, password } = req.body || {};
    // Open SaaS onboarding: anyone can self-register. The honeypot field is invisible
    // to people; bots that fill it are silently dropped with the generic failure.
    if (String(req.body?.website || '')) return reply.redirect('/signup?m=' + encodeURIComponent('Check the company, email and a password of 12+ characters.'));
    if (!company) return reply.redirect('/signup?m=' + encodeURIComponent('Enter your company name.'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return reply.redirect('/signup?m=' + encodeURIComponent('Enter a valid email address.'));
    if (String(password || '').length < 12) return reply.redirect('/signup?m=' + encodeURIComponent('Choose a password of 12 or more characters.'));
    const pw = await hashPassword(password);
    try {
      const { tenantId, userId } = await withSystem(async (c) => {
        const t = (await c.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [String(company).slice(0, 120)])).rows[0].id;
        const uid = (await c.query('INSERT INTO users (tenant_id, email, pw_hash) VALUES ($1,$2,$3) RETURNING id', [t, String(email).trim().toLowerCase(), pw])).rows[0].id;
        return { tenantId: t, userId: uid };
      });
      await withTenant(tenantId, async (c) => {
        await c.query("INSERT INTO profiles (tenant_id, company_name) VALUES (current_setting('app.tenant_id')::uuid,$1)", [String(company).slice(0, 120)]);
        await audit(c, tenantId, 'user:signup', 'tenant.created', {});
      });
      await ensureBuiltinSkills(tenantId);
      // Self-onboarding: sign the new customer straight in instead of bouncing them to the login form.
      const token = newToken();
      await withSystem((c) => c.query("INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '14 days')", [tokenHash(token), userId, tenantId]));
      reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 14 * 86400 });
      return reply.redirect('/app/agent');
    } catch (e) {
      if (String(e.message).includes('users_email_key')) return reply.redirect('/signup?m=' + encodeURIComponent('That email is already registered. Sign in instead.'));
      throw e;
    }
  });

  app.get('/login', async (req, reply) => render(reply, null, 'Sign in', `
    <div class="auth"><h1>Sign in</h1><form method="post" class="card">
    <label>Email</label><input name="email" type="email" required autocomplete="username">
    <label>Password</label><input name="password" type="password" required autocomplete="current-password">
    <p><button>Sign in</button></p><p class="mut"><a href="/forgot">Forgot your password?</a></p></form><p class="mut" style="text-align:center">New to HI? <a href="/signup">Start free</a></p></div>`, flashOf(req)));

  const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'https://hi.nahalabs.co.za').replace(/\/$/, '');
  app.get('/forgot', async (req, reply) => render(reply, null, 'Forgot password', `
    <h1>Forgot password</h1><form method="post" class="card">
    <label>Email</label><input name="email" type="email" required autocomplete="username">
    <p><button>Send reset link</button></p></form>
    <p class="mut"><a href="/login">Back to sign in</a></p>`, flashOf(req)));

  const forgotLimit = makeLimiter(5, 10 * 60 * 1000);
  app.post('/forgot', async (req, reply) => {
    if (!forgotLimit(req.ip)) return reply.code(429).send('Too many attempts. Try again later.');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const done = '/forgot?m=' + encodeURIComponent('If that email has an account, a reset link is on its way. It is valid for one hour.');
    const u = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ? (await withSystem((c) => c.query('SELECT id, tenant_id FROM users WHERE email=$1', [email]))).rows[0] : null;
    if (!u || !mailConfigured()) { await auditFor(u?.tenant_id || null, 'anonymous', 'password.reset_skipped', { reason: u ? 'mail not configured' : 'unknown email' }); return reply.redirect(done); }
    const token = newToken();
    await withSystem(async (c) => {
      await c.query("INSERT INTO password_resets (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')", [tokenHash(token), u.id, u.tenant_id]);
      await auditFor(u.tenant_id, 'anonymous', 'password.reset_requested', { user_id: u.id });
    });
    try {
      await sendMail({ to: email, subject: 'Reset your HI password', text: `Someone asked to reset the HI password for this email. If it was you, open this link within one hour:\n\n${baseUrl()}/reset/${token}\n\nIf it was not you, ignore this email - your password stays the same.`, fetchImpl });
    } catch { /* mail failure is not shown to the requester; the generic message stands */ }
    return reply.redirect(done);
  });

  const resetPage = (t, msg) => `<h1>Choose a new password</h1><form method="post" class="card">
    <label>New password (12+ characters)</label><input name="password" type="password" required minlength="12" autocomplete="new-password">
    <p><button>Save password</button></p></form>${msg ? `<p class="mut">${esc(msg)}</p>` : ''}`;
  const validReset = (t) => withSystem((c) => c.query("SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()", [tokenHash(String(t || ''))]).then((r) => r.rows[0]));
  app.get('/reset/:token', async (req, reply) => {
    const row = await validReset(req.params.token);
    if (!row) return render(reply, null, 'Reset link', '<h1>That reset link has expired or was already used.</h1><p class="mut"><a href="/forgot">Ask for a new one</a></p>', flashOf(req));
    return render(reply, null, 'New password', resetPage(req.params.token), flashOf(req));
  });
  app.post('/reset/:token', async (req, reply) => {
    const row = await validReset(req.params.token);
    if (!row) return render(reply, null, 'Reset link', '<h1>That reset link has expired or was already used.</h1><p class="mut"><a href="/forgot">Ask for a new one</a></p>', flashOf(req));
    const pw = String(req.body?.password || '');
    if (pw.length < 12 || pw.length > 200) return render(reply, null, 'New password', resetPage(req.params.token, 'Password must be at least 12 characters.'), flashOf(req));
    const hash = await hashPassword(pw);
    await withSystem(async (c) => {
      await c.query('UPDATE users SET pw_hash=$2 WHERE id=$1', [row.user_id, hash]);
      await c.query('UPDATE password_resets SET used_at=now() WHERE token_hash=$1', [row.token_hash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
      await auditFor(row.tenant_id, `user:${row.user_id}`, 'password.reset', {});
    });
    return reply.redirect('/login?m=' + encodeURIComponent('Password changed. Sign in with the new one.'));
  });

  app.post('/login', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
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
    const exportLink = '<a class="tag" href="/app/opportunities.xlsx">Download XLSX</a>';
    const cards = data.rows.map((r) => `<div class="card"><div class="row"><a href="/app/opportunity/${encodeURIComponent(r.ocid)}"><b>${esc(r.title)}</b></a><span class="score">${r.score}</span></div>
      <div class="mut">${esc(r.tender_no)} | ${esc(r.buyer)} | closes ${fdate(r.closes_at)}</div>
      <div class="mut">${r.reasons.map((x) => esc(x.text)).join(' - ')}</div></div>`).join('');
    const empty = !data.prof?.keywords?.length ? `<div class="card empty"><p style="font-size:17px;color:var(--text)"><b>No keywords yet.</b></p><p>Set your keywords first so HI knows what to look for.</p><p><a class="btn" href="/app/profile">Set up profile</a></p></div>` : (!data.rows.length ? '<div class="card empty">No opportunities here yet. HI checks for new tenders daily.</div>' : '');
    const warn = [u.paused ? '<div class="flash">Your account is paused. Nothing will be sent.</div>' : '', data.pend ? `<div class="flash">${data.pend} item(s) waiting for your approval. <a href="/app/approvals">Review</a></div>` : '', data.alerts.length ? `<div class="flash">${data.alerts.length} document(s) expired or expiring within 30 days. <a href="/app/documents">Review</a></div>` : ''].join('');
    return render(reply, u, 'Opportunities', `<h1>Opportunities for ${esc(u.tenant_name)}</h1>${warn}<p>${tabs} ${exportLink}</p>${cards}${empty}<p class="mut">Opportunity Desk tender data: National Treasury eTender Publication Portal (Open Data Commons PDDL).</p>`, flashOf(req));
  });


  app.get('/app/opportunities.xlsx', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = await withTenant(u.tenant_id, (c) => c.query(
      `SELECT t.title, t.tender_no, t.buyer, t.category, m.status, m.score, m.reasons, t.closes_at, t.source_url
       FROM matches m JOIN tenders t USING (ocid) ORDER BY m.score DESC, t.closes_at NULLS LAST LIMIT 5000`).then((r) => r.rows));
    const data = [['Title', 'Tender No', 'Buyer', 'Category', 'Status', 'Score', 'Why it matched', 'Closes At', 'Source URL'],
      ...rows.map((r) => [r.title, r.tender_no, r.buyer, r.category, r.status, r.score,
        (r.reasons || []).map((x) => x.text).join('; '), r.closes_at ? r.closes_at.toISOString() : '', r.source_url])];
    const buf = buildXlsx([{ name: 'Opportunities', rows: data }]);
    await withTenant(u.tenant_id, (c) => audit(c, u.tenant_id, `user:${u.user_id}`, 'opportunities.export', { rows: rows.length }));
    return reply.header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="hi-opportunities-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(buf);
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
      <p class="mut">Source: <a href="${safeUrl(t.source_url)}" rel="noopener noreferrer" target="_blank">official tender record</a> (fetched ${fdate(t.fetched_at)})</p></div>
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
    const rows = (await withTenant(u.tenant_id, (c) => c.query("SELECT a.*, b.body_text, m.body wa_body, m.phone wa_phone, (SELECT j.screenshots->-1->>'img' FROM browser_jobs j WHERE j.id = (a.payload->>'job_id')::uuid) shot FROM approvals a LEFT JOIN briefs b ON b.id = (a.payload->>'brief_id')::uuid LEFT JOIN wa_messages m ON a.kind='whatsapp_reply' AND m.id = (a.payload->>'wa_message_id')::bigint ORDER BY a.created_at DESC LIMIT 50"))).rows;
    const html = rows.map((a) => `<div class="card"><div class="row"><b>${esc(a.summary)}</b><span class="tag">${esc(a.status)}</span></div><div class="mut">Proposed by ${esc(a.proposed_by)} on ${fdate(a.created_at)}</div>
      ${a.shot && /^[A-Za-z0-9+/=]+$/.test(a.shot) ? `<img alt="What the browser sees now" style="max-width:100%;border:1px solid var(--line);border-radius:8px" src="data:image/jpeg;base64,${a.shot}">` : ''}${a.kind === 'social_post' ? `<div class="mut">Platform: ${a.payload?.network === 'instagram' ? 'Instagram business account' : 'Facebook page'} - bound to page: <code>${esc(String(a.payload?.account_ref || 'unknown'))}</code>${String(a.payload?.account_ref || '').endsWith('unconfigured') ? ' (no page was connected at draft time)' : ''}</div><pre>${esc(String(a.payload?.text || ''))}</pre>${a.payload?.media_url ? `<div class="mut">Media: <code>${esc(a.payload.media_url)}</code></div>` : ''}${a.payload?.link ? `<div class="mut">Link: <code>${esc(a.payload.link)}</code></div>` : ''}${['facebook', 'instagram'].includes(String(a.payload?.network)) && process.env.HI_META_SOCIAL_API_VERIFIED !== '1' ? '<div class="mut">Publishing is not switched on yet: approving files this draft and sends nothing until Facebook/Instagram support is verified.</div>' : ''}` : ''}${a.kind === 'ad_campaign_draft' ? `<div class="mut">Platform: ${a.payload?.network === 'meta' ? 'Meta Ads' : 'Google Ads'} - bound to account: <code>${esc(String(a.payload?.account_ref || 'unknown'))}</code>${String(a.payload?.account_ref || '').endsWith('unconfigured') ? ' (no ads account was connected at draft time)' : ''}</div><pre>${[a.payload?.headline, a.payload?.headline_2, a.payload?.headline_3].filter(Boolean).map((h, i2) => 'Headline ' + (i2 + 1) + ': ' + esc(String(h))).join('\n')}
${[a.payload?.body, a.payload?.description_2].filter(Boolean).map((d, i2) => 'Description ' + (i2 + 1) + ': ' + esc(String(d))).join('\n')}</pre><div class="mut">Daily budget: ${esc(a.payload?.currency || '')} ${((a.payload?.daily_budget_cents || 0) / 100).toFixed(2)}${a.payload?.audience ? ' - Audience note: ' + esc(a.payload.audience) : ''}${a.payload?.link ? ' - Link: ' : ''}${a.payload?.link ? `<code>${esc(a.payload.link)}</code>` : ''}</div><div class="mut">Targeting and keywords are finished in your own ads account before you activate anything.</div>${a.payload?.network === 'meta' && process.env.HI_META_ADS_API_VERIFIED !== '1' ? '<div class="mut">Meta ad creation is not switched on yet: approving keeps this draft on file and sends nothing until Meta support is verified.</div>' : ''}` : ''}${a.kind === 'whatsapp_reply' && a.wa_body ? `<div class="mut">To: ${esc(a.wa_phone || '')}</div><pre>${esc(a.wa_body)}</pre>` : (!['social_post', 'ad_campaign_draft'].includes(a.kind) && (a.body_text || a.payload?.body || a.payload?.instruction)) ? `<pre>${esc(a.body_text || a.payload?.body || a.payload?.instruction)}</pre>` : ''}${a.status === 'proposed' ? `<form method="post" action="/app/approvals/${a.id}">${csrf(u)}<p>${a.kind.startsWith('browser_') ? 'Approving lets the isolated browser continue.' : a.kind === 'phone_task' ? 'Approving lets your paired phone run this task. Nothing else runs on it.' : a.kind === 'whatsapp_reply' ? 'Approving sends exactly the message above to the number shown, from your WhatsApp line. Check the number and every word first.' : a.kind === 'social_post' ? (['facebook', 'instagram'].includes(String(a.payload?.network)) && process.env.HI_META_SOCIAL_API_VERIFIED !== '1' ? 'Approving files this draft while publishing is not switched on. Nothing is sent.' : 'Approving publishes exactly this post to the account shown. Publishing fails until that account is connected.') : a.kind === 'ad_campaign_draft' ? (a.payload?.network === 'meta' && process.env.HI_META_ADS_API_VERIFIED !== '1' ? 'Approving files this draft while Meta ad creation is not switched on. Nothing is created or sent.' : 'Approving creates this campaign PAUSED in the ads account shown. No money moves until you activate it there yourself. If the connected account changed since this draft, approval stops and you re-draft.') : `Approving will carry out the action shown in this approval. Check the destination and action before approving.`}</p><button name="decision" value="approve">${a.kind === 'phone_task' ? 'Approve and run' : a.kind === 'calendar_event' ? 'Approve and create event' : a.kind === 'account_email' ? 'Approve and send email' : a.kind === 'whatsapp_reply' ? 'Approve and send WhatsApp reply' : a.kind === 'social_post' ? (['facebook', 'instagram'].includes(String(a.payload?.network)) && process.env.HI_META_SOCIAL_API_VERIFIED !== '1' ? 'Approve and file draft' : 'Approve and publish post') : a.kind === 'ad_campaign_draft' ? (a.payload?.network === 'meta' && process.env.HI_META_ADS_API_VERIFIED !== '1' ? 'Approve and file draft' : 'Approve and create paused campaign') : a.kind.startsWith('browser_') ? 'Approve and continue' : 'Approve and send'}</button> <button name="decision" value="reject" class="sec">Reject</button></form>` : ''}</div>`).join('');
    return render(reply, u, 'Approvals', `<h1>Approval queue</h1><p class="mut">HI proposes. You decide. Nothing leaves your account without your approval here.</p>${html || '<div class="card empty">Nothing waiting. When HI drafts something that needs your decision, it lands here.</div>'}`, flashOf(req));
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

  app.get('/app/inbox', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const d = await withTenant(u.tenant_id, async (c) => ({
      convos: (await c.query(`SELECT m.phone, COALESCE(NULLIF(ct.name,''), m.phone) AS label,
          (SELECT body FROM wa_messages m2 WHERE m2.phone=m.phone AND m2.status <> 'ignored' ORDER BY id DESC LIMIT 1) AS last_body,
          (SELECT direction FROM wa_messages m2 WHERE m2.phone=m.phone AND m2.status <> 'ignored' ORDER BY id DESC LIMIT 1) AS last_dir,
          (SELECT created_at FROM wa_messages m2 WHERE m2.phone=m.phone AND m2.status <> 'ignored' ORDER BY id DESC LIMIT 1) AS last_at,
          count(*)::int AS n
        FROM wa_messages m LEFT JOIN wa_contacts ct ON ct.phone = m.phone
        WHERE m.status <> 'ignored'
        GROUP BY m.phone, ct.name ORDER BY last_at DESC NULLS LAST LIMIT 50`)).rows,
    }));
    const rows = d.convos.map((x) => `<a href="/app/inbox/${esc(x.phone)}" style="display:block;border-top:1px solid var(--line);padding:10px 2px;text-decoration:none;color:inherit">
      <b>${esc(x.label)}</b> <span class="mut">${x.label === x.phone ? 'WhatsApp' : esc(x.phone) + ' &middot; WhatsApp'}</span><br>
      <span>${x.last_dir === 'in' ? 'Them' : 'You'}: ${esc(String(x.last_body || '').slice(0, 160))}</span><br>
      <span class="mut">${fdate(x.last_at)} &middot; ${x.n} message${x.n === 1 ? '' : 's'}</span></a>`).join('');
    return render(reply, u, 'Inbox', `<h1>Inbox</h1><p class="mut">Your WhatsApp conversations, in one list. Only real messages appear here - nothing is made up.</p>
      <div class="card"><b>WhatsApp conversations</b>${rows || '<p class="mut">No conversations yet. When a customer messages your WhatsApp line, the conversation lands here.</p>'}</div>
      <div class="card"><b>Other channels</b><p class="mut">Instagram and Facebook messages cannot be received yet - that part is not built. Linking an account alone does not bring messages in.</p></div>`, flashOf(req));
  });

  app.get('/app/inbox/:phone', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const phone = String(req.params.phone || '');
    if (!/^[0-9]{8,15}$/.test(phone)) return reply.code(400).send('bad number');
    const d = await withTenant(u.tenant_id, async (c) => ({
      contact: (await c.query('SELECT name FROM wa_contacts WHERE phone=$1', [phone])).rows[0],
      msgs: (await c.query("SELECT direction, body, status, created_at FROM wa_messages WHERE phone=$1 AND status <> 'ignored' ORDER BY id ASC LIMIT 200", [phone])).rows,
      ch: (await c.query('SELECT number FROM wa_channels ORDER BY created_at LIMIT 1')).rows[0],
    }));
    if (!d.contact && !d.msgs.length) return reply.redirect('/app/inbox?m=' + encodeURIComponent('No conversation with that number.'));
    const label = d.contact?.name || phone;
    const thread = d.msgs.map((m) => `<div style="border-top:1px solid var(--line);padding:8px 2px"><span class="mut">${m.direction === 'in' ? 'Them' : 'You'} &middot; ${fdate(m.created_at)}${m.direction === 'out' ? ' &middot; ' + esc(m.status) : ''}</span><br>${esc(m.body)}</div>`).join('');
    return render(reply, u, `Chat with ${label}`, `<h1>${esc(label)}</h1><p class="mut">${esc(phone)} &middot; WhatsApp</p>
      <div class="card">${thread || '<p class="mut">No messages yet.</p>'}</div>
      <div class="card"><b>Reply</b>${d.ch
        ? `<p class="mut">Your reply goes to the approval queue first. It is sent only when you approve it there - exactly the words you write, to ${esc(phone)}.</p>
        <form method="post" action="/app/inbox/${esc(phone)}/reply">${csrf(u)}<textarea name="body" rows="3" maxlength="2000" required style="width:100%"></textarea><p><button>Draft reply for approval</button></p></form>`
        : '<p class="mut">No WhatsApp number is linked yet, so replies cannot be drafted.</p>'}</div>`, flashOf(req));
  });

  app.post('/app/inbox/:phone/reply', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const phone = String(req.params.phone || '');
    if (!/^[0-9]{8,15}$/.test(phone)) return reply.code(400).send('bad number');
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!body) return reply.redirect(`/app/inbox/${phone}?m=` + encodeURIComponent('Write the reply first.'));
    const r = await withTenant(u.tenant_id, async (c) => {
      const ch = (await c.query('SELECT id, engine, number FROM wa_channels ORDER BY created_at LIMIT 1')).rows[0];
      if (!ch) return { error: 'No WhatsApp number is linked yet, so replies cannot be drafted.' };
      const msg = (await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,$1,'out',$2,'proposed') RETURNING id", [phone, body])).rows[0];
      const ap = (await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'whatsapp_reply',$1,$2,$3) RETURNING id",
        [`WhatsApp reply to ${phone}: "${body.slice(0, 80)}"`,
        JSON.stringify({ wa_message_id: msg.id, channel_id: ch.id, engine: ch.engine, from: ch.number, to: phone, body }),
        `user:${u.user_id}`])).rows[0];
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'wa.owner_reply_drafted', { approval_id: ap.id, to: phone });
      return { ok: true };
    });
    if (r.error) return reply.redirect('/app/inbox?m=' + encodeURIComponent(r.error));
    return reply.redirect('/app/approvals?m=' + encodeURIComponent('Reply drafted. Approve it below to send exactly those words.'));
  });

  app.get('/app/notifications', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = await withTenant(u.tenant_id, (c) => c.query('SELECT id, at, action, detail FROM audit_log WHERE action = ANY($1) ORDER BY id DESC LIMIT 50', [NOTIF_ACTIONS])).then((r) => r.rows);
    const last = await withTenant(u.tenant_id, (c) => c.query('SELECT last_read_id FROM notification_reads WHERE user_id=$1', [u.user_id])).then((r) => r.rows[0]?.last_read_id || 0);
    const items = rows.map((a) => `<div style="border-top:1px solid var(--line);padding:8px 2px">${a.id > last ? '<b>NEW</b> &middot; ' : ''}<span class="mut">${fdate(a.at)}</span><br>${notifText(a)}</div>`).join('');
    return render(reply, u, 'Notifications', `<h1>Notifications</h1><p class="mut">Things that happened in your business. Only real recorded events appear here - nothing is made up, and marking as read never deletes the record.</p>
      <div class="card">${items || '<p class="mut">Nothing yet. When something happens - a payment, a customer message, a viewing request - it shows up here.</p>'}</div>
      ${rows.length ? `<form method="post" action="/app/notifications/read" class="card">${csrf(u)}<button>Mark all as read</button></form>` : ''}`, flashOf(req));
  });
  app.post('/app/notifications/read', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    await withTenant(u.tenant_id, (c) => c.query("INSERT INTO notification_reads (tenant_id, user_id, last_read_id, updated_at) VALUES (current_setting('app.tenant_id')::uuid,$1,(SELECT COALESCE(max(id),0) FROM audit_log),now()) ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_read_id=EXCLUDED.last_read_id, updated_at=now()", [u.user_id]));
    return reply.redirect('/app/notifications?m=' + encodeURIComponent('All caught up.'));
  });

  app.get('/app/reports', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const r = await withTenant(u.tenant_id, async (c) => {
      const payAll = (await c.query("SELECT currency, count(*)::int n, COALESCE(sum(amount_cents),0)::bigint total FROM stripe_events WHERE payment_ref IS NOT NULL GROUP BY currency ORDER BY currency")).rows;
      const payMonth = (await c.query("SELECT currency, count(*)::int n, COALESCE(sum(amount_cents),0)::bigint total FROM stripe_events WHERE payment_ref IS NOT NULL AND created_at >= date_trunc('month', now()) GROUP BY currency ORDER BY currency")).rows;
      const payRecent = (await c.query("SELECT created_at, amount_cents, currency, description FROM stripe_events WHERE payment_ref IS NOT NULL ORDER BY created_at DESC LIMIT 10")).rows;
      const waContacts = (await c.query('SELECT count(*)::int n FROM wa_contacts')).rows[0].n;
      const waWeek = (await c.query("SELECT direction, count(*)::int n FROM wa_messages WHERE created_at > now() - interval '7 days' GROUP BY direction")).rows;
      const ap = (await c.query("SELECT (count(*) FILTER (WHERE status='proposed'))::int waiting, (count(*) FILTER (WHERE decided_at > now() - interval '7 days'))::int decided7 FROM approvals")).rows[0];
      const estate = (await c.query("SELECT (SELECT count(*)::int FROM re_contacts) contacts, (SELECT count(*)::int FROM re_properties) properties, (SELECT count(*)::int FROM re_deals) deals, (SELECT count(*)::int FROM re_viewings WHERE starts_at > now() AND status='scheduled') viewings")).rows[0];
      return { payAll, payMonth, payRecent, waContacts, waWeek, ap, estate };
    });
    const money = (cents, cur) => `${esc(cur)} ${(Number(cents) / 100).toFixed(2)}`;
    const payLines = (rows) => rows.length
      ? rows.map((x) => `<tr><td>${money(x.total, x.currency)}</td><td>${x.n} payment${x.n === 1 ? '' : 's'}</td></tr>`).join('')
      : null;
    const waIn = r.waWeek.find((x) => x.direction === 'in')?.n || 0;
    const waOut = r.waWeek.find((x) => x.direction === 'out')?.n || 0;
    return render(reply, u, 'Reports', `<h1>Reports</h1><p class="mut">Every number here comes from your own records - nothing is estimated. Empty means nothing recorded yet.</p>
      <div class="card"><b>Payments - gross receipts</b><p class="mut">Money recorded as received, before any refunds. If a payment is refunded later, these totals do not change yet - refund tracking is not built. Amounts are never mixed across currencies. Times are when the payment notice reached HI, which can differ slightly from the moment of payment.</p>
        <p class="mut">This month</p>${payLines(r.payMonth) ? `<table>${payLines(r.payMonth)}</table>` : '<p class="mut">No payments recorded this month.</p>'}
        <p class="mut">All time</p>${payLines(r.payAll) ? `<table>${payLines(r.payAll)}</table>` : '<p class="mut">No payments recorded yet. When a customer pays you through your payment page, it shows up here.</p>'}
        ${r.payRecent.length ? `<p class="mut">Latest receipts (when the notice reached HI)</p><table><tr><th>When</th><th>What</th><th>Amount</th></tr>${r.payRecent.map((x) => `<tr><td>${fdate(x.created_at)}</td><td>${esc(x.description || 'Payment')}</td><td>${money(x.amount_cents, x.currency)}</td></tr>`).join('')}</table>` : ''}
      </div>
      <div class="card"><b>WhatsApp</b><table>
        <tr><td>Saved contacts</td><td>${r.waContacts}</td></tr>
        <tr><td>Messages in, last 7 days</td><td>${waIn}</td></tr>
        <tr><td>Messages out, last 7 days</td><td>${waOut}</td></tr>
      </table></div>
      <div class="card"><b>Approvals</b><table>
        <tr><td>Waiting for you now</td><td>${r.ap.waiting}</td></tr>
        <tr><td>Decided in the last 7 days</td><td>${r.ap.decided7}</td></tr>
      </table></div>
      <div class="card"><b>Real estate</b><table>
        <tr><td>Clients</td><td>${r.estate.contacts}</td></tr>
        <tr><td>Properties</td><td>${r.estate.properties}</td></tr>
        <tr><td>Deals</td><td>${r.estate.deals}</td></tr>
        <tr><td>Viewings scheduled</td><td>${r.estate.viewings}</td></tr>
      </table></div>`, flashOf(req));
  });

  app.get('/app/audit', { preHandler: guard }, async (req, reply) => {
    const rows = (await withTenant(req.user.tenant_id, (c) => c.query('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 100'))).rows;
    return render(reply, req.user, 'Audit log', `<h1>Audit log</h1><div class="card"><table><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr>${rows.map((r) => `<tr><td>${fdate(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td class="mut">${esc(JSON.stringify(r.detail))}</td></tr>`).join('')}</table></div>`);
  });

  app.get('/app/settings', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    u.desk_active = Boolean(await withTenant(u.tenant_id, (c) => c.query('SELECT COALESCE(array_length(keywords,1),0) > 0 AS active FROM profiles LIMIT 1').then((r) => r.rows[0]?.active)));
    u.emails_today = await withTenant(u.tenant_id, (c) => c.query("SELECT count(*)::int n FROM email_log WHERE sent_at > now() - interval '1 day'").then((r) => r.rows[0].n));
    u.email_cap = Number(process.env.HI_EMAIL_DAILY_CAP || 5);
    u.last_cron = await withSystem((c) => c.query("SELECT value FROM system_flags WHERE key='last_cron_run'").then((r) => r.rows[0]?.value || null));
    u.wa_owner_link = await withTenant(u.tenant_id, (c) => c.query("SELECT phone, status, code_hash IS NOT NULL AS has_code, code_expires_at, auto_reply, created_at FROM wa_owner_links WHERE status <> 'revoked' ORDER BY created_at DESC LIMIT 1").then((r) => r.rows[0] || null));
    u.stripe_links = await withTenant(u.tenant_id, (c) => c.query("SELECT id, label, token, signing_secret_enc IS NOT NULL AS has_secret, status, created_at FROM stripe_links ORDER BY created_at").then((r) => r.rows));
    u.stripe_events = await withTenant(u.tenant_id, (c) => c.query('SELECT type, amount_cents, currency, description, created_at FROM stripe_events ORDER BY created_at DESC LIMIT 10').then((r) => r.rows));
    return render(reply, u, 'Settings', `<h1>Settings</h1>
      <div class="card"><b>Emergency stop for your account</b><p class="mut">${u.paused ? 'Your account is paused. HI will not match, draft or send anything.' : 'Pause stops all matching, drafting and sending for your account immediately.'}</p>
      <form method="post" action="/app/settings/pause">${csrf(u)}<button name="paused" value="${u.paused ? 'false' : 'true'}" class="${u.paused ? '' : 'danger'}">${u.paused ? 'Resume' : 'Pause my account'}</button></form></div>
      <div class="card"><b>Morning brief</b><p class="mut">HI drafts you a short brief every morning (calendar, inbox highlights, ${u.desk_active ? 'new tender matches, ' : ''}estate follow-ups, approvals waiting). ${u.morning_brief_auto ? 'It is emailed to your own address automatically.' : 'It waits in Approvals for you each morning until you switch on auto-send.'}</p>
      <form method="post" action="/app/settings/morning-brief">${csrf(u)}<button name="on" value="${u.morning_brief_auto ? 'false' : 'true'}" class="sec">${u.morning_brief_auto ? 'Switch off auto-send' : 'Auto-send my morning brief to my own address'}</button></form></div>
      <div class="card"><b>Viewing reminders</b><p class="mut">${u.viewing_reminders_auto ? 'HI emails your own address up to 24 hours before each scheduled viewing.' : 'HI can email your own address up to 24 hours before each scheduled viewing. It never emails your clients.'}</p>
      <form method="post" action="/app/settings/viewing-reminders">${csrf(u)}<button name="on" value="${u.viewing_reminders_auto ? 'false' : 'true'}" class="sec">${u.viewing_reminders_auto ? 'Switch off viewing reminders' : 'Email me viewing reminders'}</button></form></div>
      <div class="card"><b>Expiry and lease-end reminders</b><p class="mut">${u.document_reminders_auto ? 'HI emails your own address when a document in Documents is 30 days out, 7 days out or expired, and when a recorded lease is 60 days out, 30 days out or ended.' : 'HI can email your own address when a document in Documents (FICA, licences, compliance) is 30 days out, 7 days out or expired, and when a recorded lease is 60 days out, 30 days out or ended.'}</p>
      <form method="post" action="/app/settings/doc-reminders">${csrf(u)}<button name="on" value="${u.document_reminders_auto ? 'false' : 'true'}" class="sec">${u.document_reminders_auto ? 'Switch off expiry and lease-end reminders' : 'Email me expiry and lease-end reminders'}</button></form></div>
      <div class="card"><b>WhatsApp (your own line)</b><p class="mut">Talk to HI from your own WhatsApp: log a viewing from the car, ask what is waiting, get replies here. Linking starts from this page only - HI gives you a one-time code, and your number is linked when you send that code to the HI line. No one can claim your line with just a phone number. Replies draft into your Approvals until you switch on auto-reply. Client messages stay approval-first always.</p>
      ${u.wa_owner_link && u.wa_owner_link.status === 'active' ? `<p>Linked number: <b>${esc(u.wa_owner_link.phone)}</b></p>
      <form method="post" action="/app/settings/wa-owner/auto">${csrf(u)}<button name="on" value="${u.wa_owner_link.auto_reply ? 'false' : 'true'}" class="sec">${u.wa_owner_link.auto_reply ? 'Switch off auto-reply (replies draft into Approvals)' : 'Auto-reply to my own number'}</button></form>
      <form method="post" action="/app/settings/wa-owner/unlink">${csrf(u)}<button class="sec">Unlink my number</button></form>`
      : u.wa_owner_link && u.wa_owner_link.status === 'pending' ? `<p>Your linking code: <b style="font-size:20px;letter-spacing:2px">HI-${esc(u.wa_owner_code || '')}</b></p><p class="mut">Send that code as a WhatsApp message to the HI line within 15 minutes of creating it. It works once, from your phone only.</p>
      <form method="post" action="/app/settings/wa-owner/code">${csrf(u)}<button class="sec">Create a new code (the old one stops working)</button></form>`
      : `<form method="post" action="/app/settings/wa-owner/code">${csrf(u)}<button>Create a linking code</button></form>`}</div>
      <div class="card"><b>Payments (Stripe)</b><p class="mut">HI records payments your own Stripe account receives and can draft an email to your own address for your approval when one arrives. Create a link, paste its web address into your Stripe dashboard (Developers &gt; Webhooks), choose the payment events, then paste the signing secret Stripe shows here. HI never creates charges, customers or payouts.</p>
      ${u.stripe_links.map((l) => `<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px"><b>${esc(l.label || 'Stripe link')}</b> (${esc(l.status)})<br>Webhook address: <code>https://${esc(req.headers.host || '')}/webhooks/stripe/${l.token}</code><br>Signing secret: ${l.has_secret ? 'saved' : 'not set yet'}
      <form method="post" action="/app/settings/stripe-links/${l.id}/secret">${csrf(u)}<label>Signing secret (starts with whsec_)</label><input type="password" name="secret" required minlength="10" autocomplete="off"><p><button class="sec">Save secret</button></p></form>
      <form method="post" action="/app/settings/stripe-links/${l.id}/delete">${csrf(u)}<button class="sec">Remove link and its records</button></form></div>`).join('') || '<p class="mut">No Stripe link yet.</p>'}
      <form method="post" action="/app/settings/stripe-links">${csrf(u)}<label>Label (e.g. NahaLabs store)</label><input name="label" maxlength="60"><p><button>Create Stripe link</button></p></form>
      <form method="post" action="/app/settings/stripe-notifications">${csrf(u)}<button name="on" value="${u.stripe_notifications_auto ? 'false' : 'true'}" class="sec">${u.stripe_notifications_auto ? 'Switch off payment notification drafts' : 'Draft me a payment notification for approval when one arrives'}</button></form>
      ${u.stripe_events.length ? `<table>${u.stripe_events.map((e) => `<tr><td>${fdate(e.created_at)}</td><td>${esc(fmtMoney(e.amount_cents, e.currency))}</td><td>${esc(e.description || e.type)}</td></tr>`).join('')}</table>` : '<p class="mut">No payments recorded yet.</p>'}</div>
      <div class="card"><b>Connections</b><ul><li>${u.desk_active ? 'Official tender open data: active' : 'Opportunity Desk: inactive until you set keywords in Profile'}</li><li>Email brief delivery: ${mailConfigured() ? 'configured' : 'not configured'}</li><li>AI fit notes: ${modelEnabled() ? 'on (text is redacted first; notes are marked unverified)' : 'off'}</li><li>Email sends today: ${u.emails_today} of ${u.email_cap} allowed per day</li><li>Last scheduled run: ${u.last_cron ? fdate(new Date(u.last_cron)) : 'none recorded yet'}</li><li>WhatsApp: ${u.wa_owner_link && u.wa_owner_link.status === 'active' ? 'your line is linked' : 'link your own line above'}</li></ul></div>`, flashOf(req));
  });
  app.post('/app/settings/morning-brief', { preHandler: guard }, async (req, reply) => {
    const u = req.user, on = req.body?.on === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET morning_brief_auto=$2 WHERE id=$1', [u.tenant_id, on]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, on ? 'tenant.morning_brief_auto.on' : 'tenant.morning_brief_auto.off', {});
    return reply.redirect('/app/settings?m=' + encodeURIComponent(on ? 'Morning brief will be emailed to your own address each morning.' : 'Morning brief auto-send is off.'));
  });
  app.post('/app/settings/viewing-reminders', { preHandler: guard }, async (req, reply) => {
    const u = req.user, on = req.body?.on === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET viewing_reminders_auto=$2 WHERE id=$1', [u.tenant_id, on]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, on ? 'tenant.viewing_reminders_auto.on' : 'tenant.viewing_reminders_auto.off', {});
    return reply.redirect('/app/settings?m=' + encodeURIComponent(on ? 'Viewing reminders will be emailed to your own address.' : 'Viewing reminders are off.'));
  });
  app.post('/app/settings/doc-reminders', { preHandler: guard }, async (req, reply) => {
    const u = req.user, on = req.body?.on === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET document_reminders_auto=$2 WHERE id=$1', [u.tenant_id, on]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, on ? 'tenant.doc_reminders_auto.on' : 'tenant.doc_reminders_auto.off', {});
    return reply.redirect('/app/settings?m=' + encodeURIComponent(on ? 'Expiry and lease-end reminders will be emailed to your own address.' : 'Expiry and lease-end reminders are off.'));
  });
  app.post('/app/settings/wa-owner/code', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const { randomInt, createHash } = await import('node:crypto');
    const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const hash = createHash('sha256').update(code).digest('hex');
    await withTenant(u.tenant_id, async (c) => {
      await c.query("INSERT INTO wa_owner_links (tenant_id, code_hash, code_expires_at, status) VALUES (current_setting('app.tenant_id')::uuid, $1::text, now() + interval '15 minutes', 'pending') ON CONFLICT (tenant_id) DO UPDATE SET code_hash=$1, code_expires_at=now() + interval '15 minutes', status='pending', phone=NULL, auto_reply=false", [hash]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'wa.owner_code_created', {});
    });
    return reply.redirect('/app/settings?m=' + encodeURIComponent(`Your linking code: HI-${code} - send it as a WhatsApp message to the HI line within 15 minutes. It works once and is shown only now.`));
  });
  app.post('/app/settings/wa-owner/unlink', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    await withTenant(u.tenant_id, async (c) => {
      await c.query("UPDATE wa_owner_links SET status='revoked', code_hash=NULL, code_expires_at=NULL WHERE status <> 'revoked'");
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'wa.owner_unlinked', {});
    });
    return reply.redirect('/app/settings?m=' + encodeURIComponent('Your WhatsApp number is unlinked. HI will treat it as an ordinary unknown sender.'));
  });
  app.post('/app/settings/wa-owner/auto', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const on = String(req.body?.on) === 'true';
    await withTenant(u.tenant_id, async (c) => {
      await c.query("UPDATE wa_owner_links SET auto_reply=$1 WHERE status='active'", [on]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, on ? 'wa.owner_auto_reply.on' : 'wa.owner_auto_reply.off', {});
    });
    return reply.redirect('/app/settings?m=' + encodeURIComponent(on ? 'Auto-reply on: HI answers your own WhatsApp directly.' : 'Auto-reply off: every reply drafts into your Approvals first.'));
  });
  app.post('/app/settings/stripe-links', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const r = await withTenant(u.tenant_id, async (c) => {
      const row = (await c.query("INSERT INTO stripe_links (tenant_id, label) VALUES (current_setting('app.tenant_id')::uuid, $1) RETURNING token", [String(req.body?.label || '').slice(0, 60)])).rows[0];
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'stripe.link_created', {});
      return row;
    });
    return reply.redirect('/app/settings?m=' + encodeURIComponent('Stripe link created. Paste this webhook address into your Stripe dashboard: /webhooks/stripe/' + r.token));
  });
  app.post('/app/settings/stripe-links/:id/secret', { preHandler: guard }, async (req, reply) => {
    const u = req.user, secret = String(req.body?.secret || '').trim();
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    if (!/^whsec_[A-Za-z0-9]{8,}$/.test(secret)) return reply.redirect('/app/settings?m=' + encodeURIComponent('That does not look like a Stripe signing secret (it starts with whsec_).'));
    const r = await withTenant(u.tenant_id, async (c) => {
      const upd = await c.query('UPDATE stripe_links SET signing_secret_enc=$2 WHERE id=$1', [req.params.id, enc(secret)]);
      if (upd.rowCount) await audit(c, u.tenant_id, `user:${u.user_id}`, 'stripe.secret_saved', {});
      return upd.rowCount;
    });
    return reply.redirect('/app/settings?m=' + encodeURIComponent(r ? 'Signing secret saved. Stripe events will now be verified and recorded.' : 'Link not found.'));
  });
  app.post('/app/settings/stripe-links/:id/delete', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(u.tenant_id, async (c) => { await c.query('DELETE FROM stripe_links WHERE id=$1', [req.params.id]); await audit(c, u.tenant_id, `user:${u.user_id}`, 'stripe.link_removed', {}); });
    return reply.redirect('/app/settings?m=' + encodeURIComponent('Stripe link and its recorded events removed.'));
  });
  app.post('/app/settings/stripe-notifications', { preHandler: guard }, async (req, reply) => {
    const u = req.user, on = req.body?.on === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET stripe_notifications_auto=$2 WHERE id=$1', [u.tenant_id, on]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, on ? 'tenant.stripe_notifications_auto.on' : 'tenant.stripe_notifications_auto.off', {});
    return reply.redirect('/app/settings?m=' + encodeURIComponent(on ? 'HI will email your own address when a Stripe payment arrives.' : 'Payment emails are off; receipts still show here and in your morning brief.'));
  });
  app.post('/app/settings/pause', { preHandler: guard }, async (req, reply) => {
    const u = req.user, paused = req.body?.paused === 'true';
    await withSystem((c) => c.query('UPDATE tenants SET paused=$2 WHERE id=$1', [u.tenant_id, paused]));
    await auditFor(u.tenant_id, `user:${u.user_id}`, paused ? 'tenant.paused' : 'tenant.resumed', {});
    if (paused) await withTenant(u.tenant_id, (c) => c.query("UPDATE approvals SET status='cancelled' WHERE status='proposed'"));
    return reply.redirect('/app/settings?m=' + encodeURIComponent(paused ? 'Paused.' : 'Resumed.'));
  });


  // ---------- Public API docs + key management ----------
  app.get('/developers', async (req, reply) => {
    return render(reply, null, 'HI API', `
      <h1>HI <b>API</b> for NahaLabs products.</h1>
      <p style="font-size:20px">One <b>keyed</b> API lets CargoIQ, RailWatch, ClaimTrace, MineMySol, RevenueDesk and RevUp use HI's <b>agent</b>, <b>memory</b>, <b>scheduled tasks</b>, <b>tender matching</b> and <b>browser actions</b>. Next action: create a key under <b>API keys</b> in the app.</p>
      <div class="card"><b>Authenticate</b><p>Every call sends the key as a bearer token. Keys are created in the app, shown once, and stored only as a hash on the server. They are never written to logs or pages.</p>
      <pre>Authorization: Bearer hi_...</pre>
      <p class="mut">Limits: 60 calls per minute per key. The same account budgets and approval gates as the app apply. The API can draft and propose; it never sends, buys, books or submits.</p></div>
      <div class="card"><b>Endpoints</b>
      <table>
        <tr><th>Call</th><th>What it does</th></tr>
        <tr><td><code>POST /v1/chat</code> <span class="mut">{message, agent_id?, conversation_id?}</span></td><td>Talk to the AI employee. Returns answer, conversation_id, sources.</td></tr>
        <tr><td><code>GET /v1/agents</code></td><td>List the account's agents.</td></tr>
        <tr><td><code>POST /v1/memory</code> <span class="mut">{content, kind?}</span> / <code>GET /v1/memory?query=</code></td><td>Save and search durable memory.</td></tr>
        <tr><td><code>POST /v1/tasks</code> <span class="mut">{title, instruction, every_minutes?}</span> / <code>GET /v1/tasks</code></td><td>Schedule recurring or one-off work, list tasks.</td></tr>
        <tr><td><code>POST /v1/plans</code> <span class="mut">{goal}</span> / <code>GET /v1/plans/:id</code></td><td>Multi-step job: the planner breaks the goal into steps, specialist workers run them, HI returns one combined answer.</td></tr>
        <tr><td><code>GET /v1/tenders?query=</code> / <code>GET /v1/matches</code></td><td>Opportunity Desk: search open SA tenders, or read the account's profile matches.</td></tr>
        <tr><td><code>POST /v1/browser</code> <span class="mut">{start_url, goal, mode}</span> / <code>GET /v1/browser/:id</code></td><td>Propose a browser job. It runs only after the account owner approves it in the queue; irreversible steps need a second approval.</td></tr>
      </table></div>
      <div class="card"><b>Example</b><pre>curl -s https://hi.nahalabs.co.za/v1/chat \\
  -H "Authorization: Bearer hi_..." \\
  -H "content-type: application/json" \\
  -d '{"message":"What open tenders fit a cleaning company in Gauteng?"}'</pre></div>`);
  });

  const apiKeysPage = async (u, reply, newKey = null, flash = null) => {
    const keys = await withTenant(u.tenant_id, (c) => c.query('SELECT id, name, prefix, status, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').then((r) => r.rows));
    const rows = keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}...</code></td><td><span class="chip">${k.status === 'active' ? 'active' : 'revoked'}</span></td><td>${fdate(k.created_at)}</td><td>${k.last_used_at ? fdate(k.last_used_at) : 'never'}</td><td>${k.status === 'active' ? `<form method="post" action="/app/api-keys/${k.id}/revoke" style="margin:0">${csrf(u)}<button class="sec">Revoke</button></form>` : ''}</td></tr>`).join('');
    return render(reply, u, 'API keys', `
      <h1><b>API keys</b></h1>
      <p class="mut">Keys let other NahaLabs products call your HI account. A key is shown once at creation and stored only as a hash. Docs: <a href="/developers">/developers</a>.</p>
      ${newKey ? `<div class="card"><b>Your new key - copy it now, it is never shown again:</b><pre>${esc(newKey)}</pre></div>` : ''}
      <div class="card"><table><tr><th>Name</th><th>Key</th><th>Status</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="6" class="mut">No keys yet</td></tr>'}</table></div>
      <form method="post" action="/app/api-keys" class="card">${csrf(u)}<b>Create a key</b><label>Name (which product uses it)</label><input name="name" required maxlength="60" placeholder="e.g. CargoIQ"><p><button>Create key</button></p></form>`, flash);
  };

  app.get('/app/api-keys', { preHandler: guard }, async (req, reply) => apiKeysPage(req.user, reply, null, flashOf(req)));

  app.post('/app/api-keys', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return apiKeysPage(u, reply, null, 'Give the key a name.');
    const count = await withTenant(u.tenant_id, (c) => c.query("SELECT count(*)::int n FROM api_keys WHERE status='active'").then((r) => r.rows[0].n));
    if (count >= 10) return apiKeysPage(u, reply, null, 'Limit of 10 active keys reached.');
    const key = newApiKey();
    await withTenant(u.tenant_id, async (c) => {
      await c.query("INSERT INTO api_keys (tenant_id, name, prefix, key_hash) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3)", [name, key.slice(0, 10), require_hash(key)]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'apikey.created', { name });
    });
    return apiKeysPage(u, reply, key);
  });

  app.post('/app/api-keys/:id/revoke', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id || ''))) return reply.redirect('/app/api-keys');
    await withTenant(u.tenant_id, async (c) => {
      await c.query("UPDATE api_keys SET status='revoked' WHERE id=$1", [req.params.id]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'apikey.revoked', { key_id: req.params.id });
    });
    return reply.redirect('/app/api-keys?m=' + encodeURIComponent('Key revoked.'));
  });

  // ---------- Connected integrations (Gmail, Outlook, calendars) ----------
  const oauthState = (u) => `${u.tenant_id}.${require_hash(u.tenant_id + u.csrf + (process.env.SESSION_SECRET || 'dev-only')).slice(0, 32)}`;
  const stateOk = (u, st) => secretEq(String(st || ''), oauthState(u));

  app.get('/app/integrations', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = await withTenant(u.tenant_id, (c) => c.query('SELECT id, provider, account_email, status, scopes, created_at FROM integrations ORDER BY created_at DESC').then((r) => r.rows));
    const list = rows.map((r) => `<tr><td><span class="chip">${r.provider === 'google' ? 'Google' : 'Microsoft'}</span></td><td>${esc(r.account_email)}</td><td><span class="chip">${esc(r.status)}</span></td><td>${fdate(r.created_at)}</td><td><form method="post" action="/app/integrations/${r.id}/disconnect" style="margin:0">${csrf(u)}<button class="sec">Disconnect</button></form></td></tr>`).join('');
    const card = (p, name, what) => {
      if (!integrationsConfigured()) return `<div class="card"><b>${name}</b><p class="mut">Integrations are being switched on for the platform. Check back shortly.</p></div>`;
      if (!providerConfigured(p)) return `<div class="card"><b>${name}</b><p class="mut">Not configured yet - the ${name} app registration is pending.</p></div>`;
      return `<div class="card"><b>${name}</b><p class="mut">${what}</p><p><a class="btn" href="/integrations/${p}/start">Connect ${name}</a></p></div>`;
    };
    return render(reply, u, 'Integrations', `
      <h1>Connect your <b>accounts</b>.</h1>
      <p class="mut">HI reads your connected Gmail, Outlook and calendars so it can answer with your real context. Reads happen when you ask. Every send or calendar create is drafted first and happens only after you approve it in the Approvals queue. You can disconnect any time - tokens are deleted immediately.</p>
      ${rows.length ? `<div class="card"><table><tr><th>Provider</th><th>Account</th><th>Status</th><th>Connected</th><th></th></tr>${list}</table></div>` : '<div class="card mut">Nothing connected yet.</div>'}
      ${card('google', 'Google (Gmail + Calendar)', 'Read Gmail, search your inbox, see upcoming Google Calendar events. Drafts Gmail sends and calendar events for your approval.')}
      ${card('microsoft', 'Microsoft (Outlook + Calendar)', 'Read Outlook mail, search your inbox, see upcoming Outlook Calendar events. Drafts Outlook sends and calendar events for your approval.')}`, flashOf(req));
  });

  app.get('/integrations/:provider/start', { preHandler: guard }, async (req, reply) => {
    const p = String(req.params.provider || '');
    const url = authUrlFor(p, `${baseUrl()}/integrations/${p}/callback`, oauthState(req.user));
    if (!url) return reply.redirect('/app/integrations?m=' + encodeURIComponent('That provider is not configured yet.'));
    return reply.redirect(url);
  });

  const hop = async (req, reply) => {
    // Session cookie is SameSite=Strict, so it is not sent on the cross-site redirect back from the provider.
    // Bounce once through a same-site page so the next request carries it.
    if (req.query?._h) return;
    const qs = new URLSearchParams({ ...req.query, _h: '1' }).toString();
    const target = `/integrations/${encodeURIComponent(String(req.params.provider || ''))}/callback?${qs}`;
    return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Connecting...</title><p>Connecting your account...</p><meta http-equiv="refresh" content="0;url=${esc(target)}"><noscript><a href="${esc(target)}">Continue</a></noscript>`);
  };
  app.get('/integrations/:provider/callback', { preHandler: [hop, guard] }, async (req, reply) => {
    const u = req.user, p = String(req.params.provider || '');
    if (!stateOk(u, String(req.query?.state || ''))) return reply.redirect('/app/integrations?m=' + encodeURIComponent('The connection session did not match. Try again.'));
    if (req.query?.error) return reply.redirect('/app/integrations?m=' + encodeURIComponent('The provider said: ' + String(req.query.error).slice(0, 100)));
    const code = String(req.query?.code || '');
    if (!code) return reply.redirect('/app/integrations?m=' + encodeURIComponent('No code returned. Try connecting again.'));
    const r = await connectAccount({ tenantId: u.tenant_id, provider: p, code, redirectUri: `${baseUrl()}/integrations/${p}/callback`, fetchImpl });
    if (r.error) return reply.redirect('/app/integrations?m=' + encodeURIComponent(r.error));
    return reply.redirect('/app/integrations?m=' + encodeURIComponent('Connected ' + r.account + '.'));
  });

  app.post('/app/integrations/:id/disconnect', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id || ''))) return reply.redirect('/app/integrations');
    await withTenant(u.tenant_id, async (c) => {
      await c.query('DELETE FROM integrations WHERE id=$1', [req.params.id]);
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'integration.disconnected', { integration_id: req.params.id });
    });
    return reply.redirect('/app/integrations?m=' + encodeURIComponent('Disconnected. The stored tokens were deleted.'));
  });

  app.get('/app/files', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const files = await withTenant(u.tenant_id, (c) => c.query('SELECT id, filename, mime, char_length(content) size, created_by, created_at FROM files ORDER BY created_at DESC LIMIT 100').then((r) => r.rows));
    const rows = files.map((f) => `<tr><td><a href="/app/files/${f.id}/download">${esc(f.filename)}</a></td><td><span class="chip">${esc(f.mime.split('/')[1])}</span></td><td>${Math.ceil(f.size / 1024)} KB</td><td>${esc(f.created_by)}</td><td>${fdate(f.created_at)}</td></tr>`).join('');
    const ups = await listUploads(u.tenant_id);
    const upRows = ups.map((x) => `<tr><td>${esc(x.filename)}</td><td><span class="chip">${esc((UPLOAD_TYPES[x.mime] || {}).label || x.mime)}</span></td><td>${Math.ceil(x.size_bytes / 1024)} KB</td><td>${x.has_extract ? 'yes' : 'no'}</td><td>${fdate(x.created_at)}</td></tr>`).join('');
    return render(reply, u, 'Files', `
      <h1><b>Files</b> your agent made.</h1>
      <p class="mut">Ask HI to save a report or spreadsheet and it lands here. Honest limit: csv, markdown and text for now.</p>
      <div class="card"><table><tr><th>File</th><th>Type</th><th>Size</th><th>Made by</th><th>When</th></tr>${rows || '<tr><td colspan="5" class="mut">No files yet - ask the agent to create one, e.g. "save a csv of this week\'s matches"</td></tr>'}</table></div>
      <h2 style="margin-top:18px"><b>Documents</b> you upload.</h2>
      <p class="mut">Upload an offer to purchase, FICA pack, lease or sheet (PDF, Word, text, csv - up to 8 MB). Then tell HI in chat what to do with it, e.g. "record the deadlines from the OTP I uploaded".</p>
      <div class="card"><form method="post" action="/app/uploads" enctype="multipart/form-data">${csrf(u)}<label>Document</label><input type="file" name="doc" required accept=".pdf,.docx,.txt,.md,.csv"><p><button>Upload</button></p></form></div>
      <div class="card"><table><tr><th>Document</th><th>Type</th><th>Size</th><th>Readable</th><th>When</th></tr>${upRows || '<tr><td colspan="5" class="mut">No documents uploaded yet.</td></tr>'}</table></div>`, flashOf(req));
  });
  const uploadLimit = makeLimiter(20, 60 * 60 * 1000);
  app.post('/app/uploads', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!uploadLimit(u.tenant_id)) return reply.redirect('/app/files?m=' + encodeURIComponent('Too many uploads this hour.'));
    let part;
    try { part = await req.file(); } catch { part = null; }
    if (!part) return reply.redirect('/app/files?m=' + encodeURIComponent('Choose a document first.'));
    if (!secretEq(String(part.fields?.csrf?.value || ''), u.csrf)) { reply.code(403).send('Bad request token'); return reply; }
    const mime = uploadTypeFor(part.filename, part.mimetype);
    if (!mime) return reply.redirect('/app/files?m=' + encodeURIComponent('That file type is not supported yet: PDF, Word, text, markdown or csv.'));
    let buf;
    try { buf = await part.toBuffer(); } catch { return reply.redirect('/app/files?m=' + encodeURIComponent('That file is over the 8 MB limit.')); }
    if (!buf.length) return reply.redirect('/app/files?m=' + encodeURIComponent('That file is empty.'));
    let saved;
    try {
      saved = await saveUpload(u.tenant_id, { filename: part.filename, mime, buffer: buf }, u.email);
    } catch (e) {
      if (e.code === 'TENANT_QUOTA') return reply.redirect('/app/files?m=' + encodeURIComponent(`Document storage limit reached for your workspace (${Math.round(tenantUploadQuota() / 1024 / 1024)} MB). Remove older documents first - ask HI in chat which ones you no longer need.`));
      if (e.code === 'GLOBAL_BUDGET') return reply.redirect('/app/files?m=' + encodeURIComponent('Document storage is full on HI right now. Please try again later.'));
      throw e;
    }
    return reply.redirect('/app/files?m=' + encodeURIComponent(saved.has_extract ? 'Uploaded and readable - tell HI in chat what to do with it.' : 'Uploaded. HI could not read text from this one (a scan or photo PDF); paste the key lines in chat instead.'));
  });

  app.get('/app/files/:id/download', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id || ''))) return reply.redirect('/app/files');
    const f = await withTenant(u.tenant_id, (c) => c.query('SELECT filename, mime, content FROM files WHERE id=$1', [req.params.id]).then((r) => r.rows[0]));
    if (!f) return reply.redirect('/app/files?m=' + encodeURIComponent('File not found.'));
    reply.header('content-disposition', `attachment; filename="${f.filename.replace(/"/g, '')}"`);
    if (f.mime === 'text/html') {
      // Agent-generated HTML (e.g. mandate decks) downloads as an attachment, never renders
      // inside the app origin: sandbox CSP + nosniff keep it inert until the customer opens it locally.
      reply.header('content-security-policy', "sandbox; default-src 'none'");
      reply.header('x-content-type-options', 'nosniff');
    }
    return reply.type(f.mime).send(f.mime === XLSX_MIME ? Buffer.from(f.content, 'base64') : f.content);
  });

  // Templates: prebuilt desks HI can run for a business. One entry per template;
  // adding a template later is one array item plus its dashboard route.
  const TEMPLATES = [
    { id: 'real-estate', name: 'Real estate', href: '/app/templates/real-estate',
      blurb: 'Deals, viewings, follow-ups, leases, maintenance and money records for an estate agency.' },
  ];
  app.get('/app/templates', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const cards = TEMPLATES.map((t) => `<div class="card"><a href="${t.href}"><b>${esc(t.name)}</b></a><p class="mut" style="margin:6px 0 0">${esc(t.blurb)}</p></div>`).join('');
    return render(reply, u, 'Templates', `
      <h1><b>Templates</b> for your business.</h1>
      <p class="mut">Each template is a desk HI runs for you. Open one and manage it by talking to HI.</p>
      ${cards}`, flashOf(req));
  });

  // Legacy path kept working: existing links and habits land on the real-estate template.
  app.get('/app/estate', { preHandler: guard }, async (req, reply) => reply.redirect('/app/templates/real-estate'));

  app.get('/app/templates/real-estate', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const fd = (d) => { if (!d) return ''; const x = d instanceof Date ? d : new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const STAGES = [['enquiry', 'Enquiry'], ['viewing', 'Viewing'], ['offer', 'Offer'], ['otp_signed', 'OTP signed'], ['bond_pending', 'Bond pending'], ['transfer_attorneys', 'Transfer attorneys'], ['registered', 'Registered'], ['fallen_through', 'Fallen through']];
    const OPEN = STAGES.slice(0, 6).map(([k]) => k);
    const data = await withTenant(u.tenant_id, async (c) => ({
      deals: (await c.query(`SELECT d.stage, d.next_action, d.next_action_date, d.updated_at, d.sale_price_cents, d.commission_pct, d.commission_cents, p.title AS property, co.name AS contact
        FROM re_deals d JOIN re_properties p ON p.id=d.property_id LEFT JOIN re_contacts co ON co.id=d.contact_id ORDER BY d.updated_at DESC LIMIT 100`)).rows,
      viewings: (await c.query(`SELECT v.starts_at, p.title AS property, co.name AS contact
        FROM re_viewings v JOIN re_properties p ON p.id=v.property_id LEFT JOIN re_contacts co ON co.id=v.contact_id
        WHERE v.status='scheduled' AND v.starts_at > now() - interval '1 day' ORDER BY v.starts_at LIMIT 20`)).rows,
      props: (await c.query(`SELECT count(*)::int n FROM re_properties`)).rows[0].n,
      contacts: (await c.query(`SELECT count(*)::int n FROM re_contacts`)).rows[0].n,
      sources: (await c.query(`SELECT src, sum(spend)::bigint AS spend, sum(enquiries)::int AS enquiries FROM (
        SELECT channel AS src, sum(amount_cents) AS spend, 0 AS enquiries FROM re_expenses WHERE channel <> '' AND amount_cents IS NOT NULL GROUP BY channel
        UNION ALL
        SELECT source AS src, 0 AS spend, count(*) AS enquiries FROM re_contacts WHERE source <> '' AND merged_into IS NULL GROUP BY source
      ) x GROUP BY src ORDER BY enquiries DESC, src`)).rows,
      leases: (await c.query(`SELECT l.rent_cents, l.end_date, l.status, p.title AS property, co.name AS tenant
        FROM re_leases l JOIN re_properties p ON p.id=l.property_id LEFT JOIN re_contacts co ON co.id=l.contact_id WHERE l.status='active' ORDER BY l.end_date ASC NULLS LAST LIMIT 10`)).rows,
      maintenance: (await c.query(`SELECT m.title, m.priority, m.reported_on, m.status, p.title AS property
        FROM re_maintenance m JOIN re_properties p ON p.id=m.property_id WHERE m.status IN ('open','in_progress') ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, m.reported_on LIMIT 10`)).rows,
      payments: (await c.query(`SELECT rp.amount_cents, rp.paid_on, rp.period, p.title AS property, co.name AS tenant
        FROM re_lease_payments rp JOIN re_leases l ON l.id=rp.lease_id JOIN re_properties p ON p.id=l.property_id LEFT JOIN re_contacts co ON co.id=l.contact_id ORDER BY rp.paid_on DESC, rp.created_at DESC LIMIT 5`)).rows,
      monthExpenses: (await c.query(`SELECT COALESCE(sum(amount_cents),0)::bigint AS total, count(*)::int AS n FROM re_expenses WHERE amount_cents IS NOT NULL AND spent_on >= date_trunc('month', current_date)::date`)).rows[0],
      unpaidInvoices: (await c.query(`SELECT i.invoice_no, i.amount_cents, i.due_on, co.name AS contact
        FROM re_invoices i LEFT JOIN re_contacts co ON co.id=i.contact_id WHERE i.status='sent' ORDER BY i.due_on ASC NULLS LAST LIMIT 5`)).rows,
      attention: await estateAttention(c),
    }));
    const due = data.deals.filter((d) => OPEN.includes(d.stage) && d.next_action && d.next_action_date && fd(d.next_action_date) <= fd(new Date(Date.now() + 3 * 86400000)));
    const cards = STAGES.map(([k, label]) => {
      const rows = data.deals.filter((d) => d.stage === k);
      if (!rows.length) return '';
      const money = (d) => d.commission_cents != null ? ` <span class="mut">comm R${Math.round(d.commission_cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}</span>` : (d.sale_price_cents != null ? ` <span class="mut">R${Math.round(d.sale_price_cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}</span>` : '');
      return `<div class="card"><b>${label}</b> <span class="chip">${rows.length}</span><table style="margin-top:8px">${rows.map((d) => `<tr><td>${esc(d.property)}</td><td>${esc(d.contact || '')}</td><td>${esc(d.next_action || '')}${money(d)}${d.next_action_date ? ` <span class="mut">${fd(d.next_action_date)}</span>` : ''}</td></tr>`).join('')}</table></div>`;
    }).join('');
    const dueRows = due.map((d) => `<tr><td>${fd(d.next_action_date)}</td><td>${esc(d.property)}</td><td>${esc(d.contact || '')}</td><td>${esc(d.next_action)}</td></tr>`).join('');
    const viewRows = data.viewings.map((v) => `<tr><td>${new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v.starts_at)).replace(',', '')} SAST</td><td>${esc(v.property)}</td><td>${esc(v.contact || '')}</td></tr>`).join('');
    const empty = !data.deals.length && !data.viewings.length && !data.leases.length && !data.maintenance.length && !data.payments.length && !data.unpaidInvoices.length && !data.monthExpenses.n;
    const attnCard = data.attention.length ? `<div class="card"><b>Needs attention</b> <span class="chip">${data.attention.length}</span><table style="margin-top:8px">${data.attention.map((x) => `<tr><td>${esc(x.text)}</td></tr>`).join('')}</table></div>` : '';
    const fmtR = (v) => 'R' + Math.round(Number(v) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const srcCard = data.sources.length ? `<div class="card"><b>Enquiries by source</b><table style="margin-top:8px"><tr><th>Source</th><th>Enquiries</th><th>Recorded spend</th><th>Cost per enquiry</th></tr>${data.sources.map((x) => `<tr><td>${esc(x.src.replace('_', ' '))}</td><td>${x.enquiries}</td><td>${x.spend > 0 ? fmtR(x.spend) : '<span class="mut">-</span>'}</td><td>${x.enquiries > 0 && x.spend > 0 ? fmtR(Number(x.spend) / x.enquiries) : '<span class="mut">-</span>'}</td></tr>`).join('')}</table><p class="mut" style="margin:6px 0 0">Cost per enquiry is all recorded marketing spend on a channel divided by all recorded enquiries from it (all time, both sides) - not ROI, HI does not track revenue attribution. Tell HI the channel on marketing expenses ("record R1 200 portal spend for October") and the source on each enquiry.</p></div>` : '';
    const leaseRows = data.leases.map((l) => `<tr><td>${esc(l.property)}</td><td>${esc(l.tenant || '')}</td><td>${l.rent_cents != null ? `${fmtR(l.rent_cents)} / month` : '<span class="mut">-</span>'}</td><td>${l.end_date ? esc(fd(l.end_date)) : '<span class="mut">no end date</span>'}</td></tr>`).join('');
    const maintRows = data.maintenance.map((m) => `<tr><td>${esc(m.title)}</td><td>${esc(m.property)}</td><td>${esc(m.priority)}</td><td class="mut">${esc(fd(m.reported_on))} &middot; ${esc(m.status.replace('_', ' '))}</td></tr>`).join('');
    const payRows = data.payments.map((p) => `<tr><td>${esc(fd(p.paid_on))}</td><td>${fmtR(p.amount_cents)}${p.period ? ` (${esc(p.period)})` : ''}</td><td>${esc([p.property, p.tenant].filter(Boolean).join(' - '))}</td></tr>`).join('');
    const invRows = data.unpaidInvoices.map((i) => `<tr><td>${esc(i.invoice_no || '(no number)')}</td><td>${fmtR(i.amount_cents)}</td><td>${esc(i.contact || '')}</td><td>${i.due_on ? `due ${esc(fd(i.due_on))}` : ''}</td></tr>`).join('');
    const moneyCard = (payRows || invRows || data.monthExpenses.n) ? `<div class="card"><b>Money records</b>${data.monthExpenses.n ? `<p class="mut" style="margin:6px 0 0">Expenses this month: <b>${fmtR(data.monthExpenses.total)}</b> across ${data.monthExpenses.n} entr${data.monthExpenses.n === 1 ? 'y' : 'ies'}.</p>` : ''}${payRows ? `<p class="mut" style="margin:10px 0 0"><b>Recent payments</b></p><table style="margin-top:4px">${payRows}</table>` : ''}${invRows ? `<p class="mut" style="margin:10px 0 0"><b>Unpaid invoices</b></p><table style="margin-top:4px">${invRows}</table>` : ''}</div>` : '';
    return render(reply, u, 'Real estate', `
      <h1><b>Real estate</b> deals, viewings and follow-ups.</h1>${attnCard}${srcCard}
      <p class="mut">${data.props} ${data.props === 1 ? 'property' : 'properties'}, ${data.contacts} contact${data.contacts === 1 ? '' : 's'} on record. Manage it by talking to HI - for example: <i>"Add a deal for 12 Oak Street with buyer Sipho, offer stage, next action: bank docs by Friday"</i> or <i>"seller report for 12 Oak Street"</i>.</p>
      ${empty ? '<div class="card empty">Nothing tracked yet. Tell HI about a property, a buyer or a deal and it appears here.</div>' : ''}
      ${dueRows ? `<div class="card"><b>Overdue and upcoming follow-ups</b><table style="margin-top:8px"><tr><th>Due</th><th>Property</th><th>Who</th><th>Action</th></tr>${dueRows}</table></div>` : ''}
      ${leaseRows ? `<div class="card"><b>Active leases</b><table style="margin-top:8px"><tr><th>Property</th><th>Tenant</th><th>Rent</th><th>Ends</th></tr>${leaseRows}</table></div>` : ''}
      ${maintRows ? `<div class="card"><b>Open maintenance</b><table style="margin-top:8px"><tr><th>Issue</th><th>Property</th><th>Priority</th><th>Reported</th></tr>${maintRows}</table></div>` : ''}
      ${moneyCard}
      ${viewRows ? `<div class="card"><b>Upcoming viewings</b><table style="margin-top:8px"><tr><th>When</th><th>Property</th><th>Who</th></tr>${viewRows}</table></div>` : ''}
      ${cards}`, flashOf(req));
  });

  // ---------- Agent platform ----------
  const mdLite = (t) => esc(String(t).replace(/<br\s*\/?>/gi, '\n').replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '')).replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const srcList = (src) => (src || []).length ? `<div class="mut">Sources: ${(src).map((x, i) => `[${i + 1}] <a href="${safeUrl(x.url)}" rel="noopener noreferrer" target="_blank">${esc(String(x.title || x.url).slice(0, 80))}</a>`).join(' &nbsp; ')}</div>` : '';
  const uuidOk = (x) => /^[0-9a-f-]{36}$/i.test(String(x || ''));

  app.get('/app/menu', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const grp = (g, items) => `<div class="card"><b>${g}</b><p style="margin:10px 0 2px">${items.map(([n, h]) => `<a class="chip" style="padding:8px 14px;margin:4px 6px 4px 0" href="${h}">${n}</a>`).join('')}</p></div>`;
    return render(reply, u, 'Menu', `<h1>All sections</h1>
      ${grp('Every day', [['Agent', '/app/agent'], ['Dump', '/app/dump'], ['Templates', '/app/templates'], ['Opportunities', '/app'], ['Approvals', '/app/approvals'], ['Inbox', '/app/inbox'], ['Tasks', '/app/tasks'], ['Notifications', '/app/notifications'], ['Drive', '/app/drive']])}
      ${grp('Settings', [['Profile', '/app/profile'], ['Integrations', '/app/integrations'], ['WhatsApp', '/app/whatsapp'], ['Files', '/app/files'], ['Documents', '/app/documents'], ['Briefs', '/app/briefs'], ['Reports', '/app/reports'], ['Memory', '/app/memory'], ['API keys', '/app/api-keys'], ['Audit log', '/app/audit'], ['Settings', '/app/settings']])}`, flashOf(req));
  });

  app.get('/app/agent', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    await ensureDefaultAgent(u.tenant_id);
    const d = await withTenant(u.tenant_id, async (c) => {
      const agents = (await c.query('SELECT id, name, persona FROM agents ORDER BY created_at')).rows;
      const agent = agents.find((a) => a.id === req.query.agent) || agents[0];
      const convs = (await c.query(`SELECT id, title, created_at FROM conversations WHERE agent_id=$1 AND title NOT LIKE 'Scheduled task "%' ORDER BY created_at DESC LIMIT 15`, [agent.id])).rows;
      const conv = uuidOk(req.query.c) ? convs.find((x) => x.id === req.query.c) : null;
      const msgs = conv ? (await c.query('SELECT role, content, sources, steps, created_at FROM messages WHERE conversation_id=$1 ORDER BY id', [conv.id])).rows : [];
      return { agents, agent, convs, conv, msgs };
    });
    const thread = `<div id="thread">${d.msgs.map((m, i) => {
      const opts = (m.role === 'assistant' && i === d.msgs.length - 1) ? (m.steps || []).find((x) => x.type === 'options') : null;
      const chips = opts ? `<div style="margin-top:6px">${opts.items.map((o) => `<form method="post" action="/app/agent/message" class="ask">${csrf(u)}<input type="hidden" name="agent" value="${d.agent.id}"><input type="hidden" name="c" value="${d.conv ? d.conv.id : ''}"><input type="hidden" name="text" value="${esc(o)}"><button class="sec">${esc(o)}</button></form>`).join('')}</div>` : '';
      return `<div class="msg ${m.role === 'user' ? 'me' : 'hi'}"><div class="who">${m.role === 'user' ? 'You' : esc(d.agent.name)}</div><div>${mdLite(m.content)}</div>${m.role === 'assistant' ? srcList(m.sources) : ''}${(m.steps || []).filter((x) => x.type === 'tool').length ? `<div class="mut">Used: ${(m.steps).filter((x) => x.type === 'tool').map((x) => esc(toolLabel(x.name))).filter(Boolean).join(', ')}</div>` : ''}${chips}</div>`;
    }).join('')}</div>`;
    const talk = voiceConfigured() ? `<div id="talkbox" data-csrf="${esc(u.csrf)}" data-c="${d.conv ? d.conv.id : ''}" style="margin-top:8px"><button type="button" id="talkbtn" class="sec">Talk</button> <span id="talkstatus" class="mut"></span></div><script src="/talk.js" defer></script>` : '';
    const switcher = d.agents.length > 1 ? `<span class="mut small">${d.agents.map((a) => `<a href="/app/agent?agent=${a.id}">${esc(a.name)}</a>`).join(' &middot; ')}</span>` : '';
    const starters = ['Add a deal for 12 Oak Street with buyer Sipho, offer stage', 'What follow-ups are due this week?', 'Seller report for 12 Oak Street'];
    const emptyChat = `<div class="card empty"><p style="font-size:18px;color:var(--text)"><b>Ask HI anything.</b></p><p>Research with cited sources, remember a fact about your business, find tenders, schedule a job. HI drafts - you approve anything that leaves your account.</p>${starters.map((q) => `<form method="post" action="/app/agent/message" class="ask">${csrf(u)}<input type="hidden" name="agent" value="${d.agent.id}"><input type="hidden" name="text" value="${esc(q)}"><button class="sec">${esc(q)}</button></form>`).join('')}</div>`;
    return render(reply, u, 'Agent', `<div class="row" style="margin-bottom:2px"><h1 style="margin:0">Agent</h1><span>${switcher} ${agentModelEnabled() ? '' : '<span class="bad small">AI model not configured</span>'}</span></div>
      ${d.msgs.length ? '' : emptyChat}${thread}
      <form method="post" action="/app/agent/message" class="card">${csrf(u)}<input type="hidden" name="agent" value="${d.agent.id}"><input type="hidden" name="c" value="${d.conv ? d.conv.id : ''}">
        <label>Message ${esc(d.agent.name)}</label><textarea name="text" rows="3" maxlength="4000" required></textarea><p><button>Send</button></p>${talk}</form>
      <div class="card"><b>Recent conversations</b><ul>${d.convs.map((x) => `<li><a href="/app/agent?agent=${d.agent.id}&c=${x.id}">${esc(x.title)}</a> <span class="mut">${fdate(x.created_at)}</span></li>`).join('') || '<li class="mut">None yet</li>'}</ul></div>
      <details class="card"><summary style="cursor:pointer"><b>Add another named agent</b></summary><form method="post" action="/app/agent/new">${csrf(u)}<label>Name</label><input name="name" required maxlength="40"><label>What is this agent for?</label><input name="persona" maxlength="300" placeholder="e.g. Handles supplier research and quotes"><p><button class="sec">Create agent</button></p></form></details>`, flashOf(req));
  });
  const msgLimit = makeLimiter(30, 60 * 60 * 1000);
  app.post('/app/agent/message', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const { agent, c: conv, text } = req.body || {};
    if (!uuidOk(agent) || !String(text || '').trim()) return reply.redirect('/app/agent?m=' + encodeURIComponent('Write a message first.'));
    if (uuidOk(conv)) { const owns = await withTenant(u.tenant_id, (c) => c.query('SELECT 1 FROM conversations WHERE id=$1', [String(conv)]).then((r) => r.rowCount > 0)); if (!owns) return reply.redirect('/app/agent?m=' + encodeURIComponent('That conversation is not available.')); }
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

  // ---- Drive Mode: browser voice (Drive Companion slice 1) ----
  const voiceGuard = async (req, reply) => {
    const sess = await sessionOf(req);
    if (!sess) { reply.code(401).send({ error: 'Sign in first.' }); return reply; }
    if (!secretEq(String(req.query?.csrf || ''), sess.csrf)) { reply.code(403).send({ error: 'Bad request token' }); return reply; }
    req.user = sess;
  };
  app.get('/app/drive', { preHandler: guard }, async (req, reply) => {
    await ensureDefaultAgent(req.user.tenant_id);
    return reply.type('text/html').send(drivePage({ csrf: req.user.csrf, voiceOn: voiceConfigured() }));
  });
  const voiceLimit = makeLimiter(60, 60 * 60 * 1000);
  app.post('/app/voice/turn', { preHandler: voiceGuard, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const u = req.user;
    if (!voiceConfigured()) return reply.code(503).send({ error: 'Voice is not configured on this server yet.' });
    if (!voiceLimit(u.tenant_id)) return reply.code(429).send({ error: 'Voice turn limit reached for this hour.' });
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return reply.code(400).send({ error: 'No audio received.' });
    if (bytes.length > voiceMaxBytes()) return reply.code(413).send({ error: 'Keep one voice turn under about a minute.' });
    let transcript;
    try { transcript = await transcribe({ bytes, mime: req.headers['content-type'], fetchImpl }); }
    catch { return reply.code(502).send({ error: 'Speech-to-text is unavailable right now. Try again shortly.' }); }
    if (!transcript) return reply.send({ transcript: '', answer: 'I could not make that out. Try again, a little closer to the phone.', tts: 'client', status: 'empty' });
    const agent = await ensureDefaultAgent(u.tenant_id);
    // Only continue a conversation this tenant actually owns.
    const wantConv = uuidOk(req.query.c) ? String(req.query.c) : null;
    const convOk = wantConv ? await withTenant(u.tenant_id, (c) => c.query('SELECT 1 FROM conversations WHERE id=$1', [wantConv]).then((r) => r.rowCount > 0)) : false;
    const r = await runAgent({ tenantId: u.tenant_id, userEmail: u.email, agentId: agent.id, conversationId: convOk ? wantConv : null, userText: transcript, llm, fetchImpl, lookup, voice: true });
    if (r.error) return reply.send({ transcript, answer: r.error, tts: 'client', status: 'failed', conversationId: null });
    const wav = await speak({ text: r.answer, fetchImpl });
    await auditFor(u.tenant_id, `user:${u.user_id}`, 'voice.turn', { run_id: r.runId, chars: transcript.length, tts: wav ? 'server' : 'client' });
    return reply.send({ transcript, answer: r.answer, conversationId: r.conversationId, status: r.status, audio: wav ? wav.toString('base64') : null, tts: wav ? 'server' : 'client' });
  });

  // Due-task results surface in Drive Mode: the page polls and speaks them.
  app.get('/app/voice/alerts', { preHandler: voiceGuard }, async (req, reply) => {
    const u = req.user;
    const alerts = await withTenant(u.tenant_id, async (c) => {
      const rows = (await c.query(
        `SELECT r.id, r.result, t.title FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.task_id IS NOT NULL AND r.status='done' AND r.surfaced_at IS NULL AND r.result IS NOT NULL
         ORDER BY r.created_at LIMIT 3`)).rows;
      if (rows.length) {
        await c.query('UPDATE runs SET surfaced_at=now() WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
        await audit(c, u.tenant_id, `user:${u.user_id}`, 'voice.alerts', { delivered: rows.length });
      }
      return rows;
    });
    return reply.send({ alerts: alerts.map((r) => ({ id: r.id, title: r.title, text: String(r.result || '').slice(0, 400) })) });
  });

  app.get('/app/tasks', { preHandler: guard }, async (req, reply) => {
    const u = req.user; await ensureDefaultAgent(u.tenant_id);
    const d = await withTenant(u.tenant_id, async (c) => ({
      tasks: (await c.query('SELECT t.*, a.name agent_name FROM tasks t JOIN agents a ON a.id=t.agent_id ORDER BY t.created_at DESC LIMIT 100')).rows,
      running: (await c.query("SELECT DISTINCT task_id FROM runs WHERE status='running' AND task_id IS NOT NULL")).rows.map((x) => x.task_id),
      agents: (await c.query('SELECT id, name FROM agents ORDER BY created_at')).rows }));
    const every = (t) => t.interval_minutes ? `every ${t.interval_minutes % 60 === 0 ? `${t.interval_minutes / 60} h` : `${t.interval_minutes} min`}${t.window_start != null ? `, ${String(t.window_start).padStart(2, '0')}:00-${String(t.window_end).padStart(2, '0')}:00` : ''}` : 'once';
    const now = Date.now();
    const active = d.tasks.filter((t) => t.status !== 'done' && (d.running.includes(t.id) || (!t.interval_minutes && t.next_run_at && new Date(t.next_run_at).getTime() <= now)));
    const upNext = d.tasks.filter((t) => t.status !== 'done' && !active.includes(t) && !t.interval_minutes);
    const scheduled = d.tasks.filter((t) => t.status !== 'done' && !active.includes(t) && t.interval_minutes);
    const resolved = d.tasks.filter((t) => t.status === 'done');
    const row = (t) => `<tr><td><a href="/app/tasks/${t.id}"><b>${esc(t.title)}</b></a><div class="mut">${esc(t.instruction.slice(0, 120))}</div></td>
      <td>${every(t)}${t.status === 'paused' ? ' <span class="tag">paused</span>' : ''}${d.running.includes(t.id) ? ' <span class="tag">running now</span>' : ''}</td>
      <td>${t.status === 'done' ? fdate(t.last_run_at) : fdate(t.next_run_at)}</td>
      <td>${t.status !== 'done' ? `<form method="post" action="/app/tasks/${t.id}/toggle" style="display:inline">${csrf(u)}<button class="sec">${t.status === 'active' ? 'Pause' : 'Resume'}</button></form>` : ''}<form method="post" action="/app/tasks/${t.id}/delete" style="display:inline">${csrf(u)}<button class="sec">Delete</button></form></td></tr>`;
    const bucket = (name, hint, rows) => `<div class="card"><b>${name}</b>${rows.length ? `<span class="chip">${rows.length}</span><table class="tasklist" style="margin-top:8px"><tr><th>Task</th><th>Runs</th><th>${name === 'Resolved' ? 'Last run' : 'Next'}</th><th></th></tr>${rows.map(row).join('')}</table>` : `<p class="mut" style="margin:6px 0 0">${hint}</p>`}</div>`;
    return render(reply, u, 'Tasks', `<h1>Tasks</h1>
      ${bucket('Active', 'Nothing running right now.', active)}
      ${upNext.length ? bucket('Up next', '', upNext) : ''}
      ${bucket('Scheduled', 'No routines yet. Ask HI to check or do something on a schedule.', scheduled)}
      ${resolved.length ? bucket('Resolved', '', resolved) : ''}
      <form method="post" action="/app/tasks" class="card">${csrf(u)}<b>New task</b><label>Title</label><input name="title" required maxlength="120"><label>What should the agent do each time?</label><textarea name="instruction" rows="3" maxlength="2000" required></textarea>
        <label>Agent</label><select name="agent">${d.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><label>Repeat every (minutes, 60 or more, blank for once)</label><input name="every" type="number" min="60"><label>First run in (minutes)</label><input name="first" type="number" min="1" value="60"><p><button>Schedule</button></p></form>`, flashOf(req));
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
  app.get('/app/tasks/:id', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    const u = req.user;
    const d = await withTenant(u.tenant_id, async (c) => ({
      task: (await c.query('SELECT t.*, a.name agent_name FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.id=$1', [req.params.id])).rows[0],
      runs: (await c.query('SELECT id, status, result, sources, created_at FROM runs WHERE task_id=$1 ORDER BY created_at ASC LIMIT 50', [req.params.id])).rows,
    }));
    if (!d.task) return reply.redirect('/app/tasks?m=' + encodeURIComponent('That task is not available.'));
    const t = d.task;
    const every = t.interval_minutes ? `every ${t.interval_minutes % 60 === 0 ? `${t.interval_minutes / 60} h` : `${t.interval_minutes} min`}` : 'once';
    const window = t.window_start != null ? `, ${String(t.window_start).padStart(2, '0')}:00-${String(t.window_end).padStart(2, '0')}:00 SAST` : '';
    return render(reply, u, t.title, `<h1><b>${esc(t.title)}</b></h1>
      <p class="mut">Runs ${every}${window} &middot; ${esc(t.status)}${t.last_run_at ? ` &middot; last run ${fdate(t.last_run_at)}` : ''} &middot; next run ${fdate(t.next_run_at)}. <a href="/app/tasks">All tasks</a></p>
      <h2>Thread</h2>${d.runs.map((r) => `<div class="card"><div class="row"><span class="tag">${esc(r.status)}</span><span class="mut">${fdate(r.created_at)}</span></div><div>${mdLite((r.result || '').slice(0, 1500))}</div>${srcList(r.sources)}</div>`).join('') || '<div class="card mut">No runs yet.</div>'}`, flashOf(req));
  });

  app.post('/app/tasks/:id/delete', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => { await c.query('DELETE FROM tasks WHERE id=$1', [req.params.id]); await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'task.deleted', { task_id: req.params.id }); });
    return reply.redirect('/app/tasks?m=' + encodeURIComponent('Deleted.'));
  });

  // ---- Brain dump: one box -> the agent splits it into tasks -> start now or save for later ----
  app.get('/app/dump', { preHandler: guard }, async (req, reply) => {
    const u = req.user; await ensureDefaultAgent(u.tenant_id);
    const list = await activeList(u.tenant_id);
    const drafts = await withTenant(u.tenant_id, (c) => c.query("SELECT id, raw, created_at FROM dumps WHERE status='draft' ORDER BY created_at DESC LIMIT 10").then((r) => r.rows));
    const reviewCards = list.review.map((r) => `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row"><b>${esc(r.title || 'Task')}</b><form method="post" action="/app/runs/${r.id}/review" class="ask">${csrf(u)}<button class="sec">Mark reviewed</button></form></div><div class="mut small">${fdate(r.created_at)}</div><div>${mdLite((r.result || '').slice(0, 600))}</div></div>`).join('');
    const inputRows = list.needsInput.map((a) => `<li><a href="/app/approvals">${esc(a.summary)}</a> <span class="mut small">${fdate(a.created_at)}</span></li>`).join('');
    const workingRows = list.working.map((r) => `<li>${esc(r.title || 'Task')} <span class="tag">working now</span></li>`).join('')
      + list.queued.map((t) => `<li>${esc(t.title)} <span class="tag">queued ${fdate(t.next_run_at)}</span></li>`).join('');
    return render(reply, u, 'Brain dump', `<h1>Brain dump</h1>
      <form method="post" action="/app/dump" class="card">${csrf(u)}
        <b>Everything on your mind, in one go</b>
        <p class="mut">Type it all - every task, reminder and idea. HI splits it into separate tasks. You check the split, then start the work now or save it for later.</p>
        <textarea name="raw" rows="6" maxlength="${MAX_DUMP_CHARS}" required placeholder="e.g. Follow up the Sandton quote&#10;Ask Sipho about the viewing Saturday&#10;Find three electricians for the Midrand job&#10;Remind me to renew the CIPC registration"></textarea>
        <p><button>Split into tasks</button></p></form>
      <div class="card"><b>Active</b>
        <h2 style="margin-top:10px">Needs your input</h2>
        ${inputRows ? `<ul>${inputRows}</ul>` : '<p class="mut">Nothing waiting on you.</p>'}
        <h2>Waiting for your review</h2>
        ${reviewCards || '<p class="mut">No finished work to review.</p>'}
        <h2>Agent is working on</h2>
        ${workingRows ? `<ul>${workingRows}</ul>` : '<p class="mut">Nothing in flight.</p>'}</div>
      ${drafts.length ? `<div class="card"><b>Saved for later</b><ul>${drafts.map((d) => `<li><a href="/app/dump/${d.id}">${esc(d.raw.slice(0, 80))}${d.raw.length > 80 ? '...' : ''}</a> <span class="mut small">${fdate(d.created_at)}</span></li>`).join('')}</ul></div>` : ''}`, flashOf(req));
  });
  const dumpLimit = makeLimiter(20, 60 * 60 * 1000);
  app.post('/app/dump', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const raw = String(req.body?.raw || '').trim().slice(0, MAX_DUMP_CHARS);
    if (!raw) return reply.redirect('/app/dump?m=' + encodeURIComponent('Write what is on your mind first.'));
    if (!dumpLimit(u.tenant_id)) return reply.redirect('/app/dump?m=' + encodeURIComponent('Too many dumps this hour.'));
    const agent = await ensureDefaultAgent(u.tenant_id);
    const { items, via } = await splitDump({ raw, tenantId: u.tenant_id, llm, fetchImpl });
    if (!items.length) return reply.redirect('/app/dump?m=' + encodeURIComponent('Could not split that into tasks - try one line per task.'));
    const id = await withTenant(u.tenant_id, async (c) => {
      const r = (await c.query("INSERT INTO dumps (tenant_id, agent_id, raw, items) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3) RETURNING id", [agent.id, raw, JSON.stringify(items)])).rows[0];
      await audit(c, u.tenant_id, `user:${u.user_id}`, 'dump.split', { dump_id: r.id, items: items.length, via });
      return r.id;
    });
    return reply.redirect(`/app/dump/${id}`);
  });
  app.get('/app/dump/:id', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!uuidOk(req.params.id)) return reply.redirect('/app/dump');
    const d = await withTenant(u.tenant_id, (c) => c.query('SELECT id, raw, items, status FROM dumps WHERE id=$1', [req.params.id]).then((r) => r.rows[0]));
    if (!d) return reply.redirect('/app/dump?m=' + encodeURIComponent('That dump is not available.'));
    const items = Array.isArray(d.items) ? d.items : [];
    const rows = items.map((it, i) => `<div style="border-top:1px solid var(--line);padding:10px 0"><label style="display:flex;gap:10px;align-items:flex-start;color:var(--text)"><input type="checkbox" name="include" value="${i}" checked style="width:auto;margin-top:5px"><span style="flex:1"><input name="title" value="${esc(it.title)}" maxlength="80" aria-label="Task title"><textarea name="instruction" rows="2" maxlength="500" aria-label="What the agent should do">${esc(it.instruction)}</textarea></span></label></div>`).join('');
    const startable = d.status === 'draft';
    return render(reply, u, 'Review your split', `<h1>Review your split</h1>
      <div class="card"><b>Your dump</b><p class="mut">${esc(d.raw.slice(0, 400))}${d.raw.length > 400 ? '...' : ''}</p></div>
      <form method="post" action="/app/dump/${d.id}" class="card">${csrf(u)}
        <b>${items.length} task${items.length === 1 ? '' : 's'}</b> <span class="mut">- untick any you do not want, edit the words freely.</span>
        ${rows}
        ${startable ? `<p><button name="action" value="start">Start now</button> <button class="sec" name="action" value="save">Save for later</button></p>` : '<p class="mut">Already started.</p>'}</form>
      ${startable ? `<form method="post" action="/app/dump/${d.id}/delete" class="card">${csrf(u)}<button class="sec danger">Delete this dump</button></form>` : ''}`, flashOf(req));
  });
  app.post('/app/dump/:id', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    if (!uuidOk(req.params.id)) return reply.redirect('/app/dump');
    const b = req.body || {};
    const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
    const titles = arr(b.title), instructions = arr(b.instruction);
    const include = new Set(arr(b.include).map((x) => Number(x)));
    const items = titles.map((t, i) => ({ title: t, instruction: instructions[i] })).filter((_, i) => include.size ? include.has(i) : true);
    if (b.action === 'save') {
      await withTenant(u.tenant_id, async (c) => {
        await c.query("UPDATE dumps SET items=$2 WHERE id=$1 AND status='draft'", [req.params.id, JSON.stringify(items)]);
        await audit(c, u.tenant_id, `user:${u.user_id}`, 'dump.saved', { dump_id: req.params.id, items: items.length });
      });
      return reply.redirect('/app/dump?m=' + encodeURIComponent('Saved for later.'));
    }
    const r = await startDump({ tenantId: u.tenant_id, userId: u.user_id, dumpId: req.params.id, items });
    if (r.error) return reply.redirect(`/app/dump/${req.params.id}?m=` + encodeURIComponent(r.error));
    return reply.redirect('/app/dump?m=' + encodeURIComponent(`Started ${r.started} task${r.started === 1 ? '' : 's'} - the agent picks them up on the next run.`));
  });
  app.post('/app/dump/:id/delete', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.redirect('/app/dump');
    await withTenant(req.user.tenant_id, async (c) => {
      await c.query("UPDATE dumps SET status='archived' WHERE id=$1 AND status='draft'", [req.params.id]);
      await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'dump.archived', { dump_id: req.params.id });
    });
    return reply.redirect('/app/dump?m=' + encodeURIComponent('Deleted.'));
  });
  app.post('/app/runs/:id/review', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => {
      await c.query('UPDATE runs SET reviewed_at=now() WHERE id=$1 AND reviewed_at IS NULL', [req.params.id]);
      await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'run.reviewed', { run_id: req.params.id });
    });
    return reply.redirect('/app/dump?m=' + encodeURIComponent('Marked reviewed.'));
  });

  app.get('/app/memory', { preHandler: guard }, async (req, reply) => {
    const u = req.user;
    const rows = (await withTenant(u.tenant_id, (c) => c.query('SELECT id, kind, content, source, created_at FROM memories ORDER BY created_at DESC LIMIT 100'))).rows;
    const cand = (await withTenant(u.tenant_id, (c) => c.query("SELECT id, detail, created_at FROM memory_notes WHERE kind='memory_candidate' ORDER BY created_at DESC LIMIT 20"))).rows;
    const candCard = cand.length ? `<div class="card"><b>Suggested by HI - review before they are remembered</b><p class="mut">Nothing here reaches your agent until you approve it.</p>${cand.map((x) => `<div style="border-top:1px solid var(--line);padding:10px 0"><div>${esc(x.detail)}</div><div style="margin-top:6px"><form method="post" action="/app/memory/candidate/${x.id}/approve" class="ask">${csrf(u)}<button>Remember</button></form><form method="post" action="/app/memory/candidate/${x.id}/dismiss" class="ask">${csrf(u)}<button class="sec">Dismiss</button></form></div></div>`).join('')}</div>` : '';
    return render(reply, u, 'Memory', `<h1>What your agents remember</h1><p class="mut">You can see and delete everything saved here. Core memories are always in the agent's mind; archival ones are searched when relevant.</p>
      ${candCard}
      <form method="post" action="/app/memory" class="card">${csrf(u)}<label>Add a memory</label><input name="content" required maxlength="1000"><label>Type</label><select name="kind"><option value="core">core (always remembered)</option><option value="archival">archival</option></select><p><button>Save</button></p></form>
      <div class="card"><table class="mem"><thead><tr><th>When</th><th>Type</th><th>Source</th><th>Memory</th><th></th></tr></thead>${rows.map((m) => `<tr><td class="mmeta">${fdate(m.created_at)}</td><td class="mmeta">${esc(m.kind)}</td><td class="mmeta">${esc(m.source || 'owner')}</td><td>${esc(m.content)}</td><td><form method="post" action="/app/memory/${m.id}/delete">${csrf(u)}<button class="sec">Delete</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="mut">Nothing saved yet.</td></tr>'}</table></div>`, flashOf(req));
  });
  app.post('/app/memory', { preHandler: guard }, async (req, reply) => {
    const u = req.user, content = String(req.body?.content || '').trim().slice(0, 1000);
    if (content) await withTenant(u.tenant_id, async (c) => { await c.query("INSERT INTO memories (tenant_id, kind, content) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [req.body?.kind === 'core' ? 'core' : 'archival', content]); await audit(c, u.tenant_id, `user:${u.user_id}`, 'memory.saved', {}); });
    return reply.redirect('/app/memory?m=' + encodeURIComponent('Saved.'));
  });
  app.post('/app/memory/candidate/:id/approve', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => {
      const cand = (await c.query("SELECT detail FROM memory_notes WHERE id=$1 AND kind='memory_candidate'", [req.params.id])).rows[0];
      if (cand) {
        await c.query("INSERT INTO memories (tenant_id, kind, content) VALUES (current_setting('app.tenant_id')::uuid,'archival',$1)", [cand.detail.slice(0, 1000)]);
        await c.query('DELETE FROM memory_notes WHERE id=$1', [req.params.id]);
        await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'memory.suggestion_approved', {});
      }
    });
    return reply.redirect('/app/memory?m=' + encodeURIComponent('Remembered.'));
  });
  app.post('/app/memory/candidate/:id/dismiss', { preHandler: guard }, async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send('bad id');
    await withTenant(req.user.tenant_id, async (c) => { await c.query("DELETE FROM memory_notes WHERE id=$1 AND kind='memory_candidate'", [req.params.id]); await audit(c, req.user.tenant_id, `user:${req.user.user_id}`, 'memory.suggestion_dismissed', {}); });
    return reply.redirect('/app/memory?m=' + encodeURIComponent('Dismissed.'));
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
  // Meta Cloud API webhook: GET verifies the endpoint, POST delivers inbound messages.
  // Encapsulated so the JSON parser can keep the raw body for X-Hub-Signature-256.
  app.register(async (wa) => {
    wa.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      req.rawBody = body;
      try { done(null, JSON.parse(body.toString('utf8') || '{}')); } catch { done(null, {}); }
    });
    wa.get('/webhooks/whatsapp', async (req, reply) => {
      const ok = req.query?.['hub.mode'] === 'subscribe' && secretEq(String(req.query?.['hub.verify_token'] || ''), process.env.WA_META_VERIFY_TOKEN);
      return ok ? reply.type('text/plain').send(String(req.query['hub.challenge'])) : reply.code(403).send({ error: 'bad verify token' });
    });
    wa.post('/webhooks/whatsapp', async (req, reply) => {
      const appSecret = process.env.WA_META_APP_SECRET;
      if (!appSecret) return reply.code(503).send({ error: 'meta_cloud not configured' });
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const hmac = createHmac('sha256', appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
      if (!secretEq(sig, `sha256=${hmac}`)) return reply.code(401).send({ error: 'bad signature' });
      const adapter = makeAdapter(fetchImpl);
      const results = [];
      for (const m of parseMetaWebhook(req.body)) {
        results.push(await handleInbound({ ...m, llm, fetchImpl, lookup, adapter }));
      }
      return reply.send({ received: results.length });
    });
  });

    // Stripe webhooks: per-tenant unguessable URL token; raw body kept for Stripe-Signature verification.
  app.register(async (stripe) => {
    stripe.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      req.rawBody = body;
      try { done(null, JSON.parse(body.toString('utf8') || '{}')); } catch { done(null, {}); }
    });
    stripe.post('/webhooks/stripe/:token', async (req, reply) => {
      const r = await handleStripeWebhook({ token: String(req.params.token || ''), rawBody: req.rawBody, sigHeader: String(req.headers['stripe-signature'] || ''), fetchImpl });
      return reply.code(r.status || 200).send(r);
    });
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
    if (job === 'morning-brief' || job === 'all') out.morning_brief = await buildMorningBriefs({ fetchImpl });
    if (job === 'viewing-reminders' || job === 'all') out.viewing_reminders = await runViewingReminders({ fetchImpl });
    if (job === 'doc-reminders' || job === 'all') out.doc_reminders = await runDocExpiryReminders({ fetchImpl });
    await withSystem((c) => c.query("INSERT INTO system_flags (key, value) VALUES ('last_cron_run', to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SSOF')) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"));
    return out;
  });
  app.post('/internal/stop', { preHandler: cronAuth }, async (req) => { await setEmergencyStop(req.query.on !== 'false'); return { emergency_stop: req.query.on !== 'false' }; });

  app.addHook('onClose', async () => { await closePool(); });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Schema before traffic: apply migrations when an owner connection is configured, then
  // refuse to serve until every table schema.sql declares exists. An incomplete schema fails
  // the deploy here instead of serving 500s to customers.
  if (process.env.MIGRATE_DATABASE_URL) {
    const { migrate } = await import('./migrate.js');
    await migrate(process.env.MIGRATE_DATABASE_URL, process.env.HI_APP_PASSWORD);
    console.log('schema migration applied');
  }
  try {
    await assertSchemaReady();
  } catch (e) {
    console.error('FATAL: ' + e.message);
    process.exit(1);
  }
  const app = await buildApp({ logger: true });
  await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
}
