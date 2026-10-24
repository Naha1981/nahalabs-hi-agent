import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runViewingReminders } from '../src/reminders.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, app, A, B, sent = [];
const llm = async () => ({ content: 'done', tool_calls: [] });
const fakeFetch = async (url, opts) => {
  if (String(url).includes('resend.com')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'mail_' + sent.length }) }; }
  throw new Error('unexpected fetch ' + url);
};
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

async function mkViewing(tenantId, hoursAhead, contactName = 'Sipho Dube') {
  return withTenant(tenantId, async (c) => {
    const p = (await c.query("INSERT INTO re_properties (tenant_id, title) VALUES (current_setting('app.tenant_id')::uuid, '12 Oak Street, Sandton') RETURNING id")).rows[0];
    const k = (await c.query("INSERT INTO re_contacts (tenant_id, name, role) VALUES (current_setting('app.tenant_id')::uuid, $1, 'buyer') RETURNING id", [contactName])).rows[0];
    const v = (await c.query("INSERT INTO re_viewings (tenant_id, property_id, contact_id, starts_at) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, now() + ($3 || ' hours')::interval) RETURNING id", [p.id, k.id, String(hoursAhead)])).rows[0];
    return v.id;
  });
}

test.before(async () => {
  db = await startDb(54337);
  app = await buildApp({ llm, fetchImpl: fakeFetch });
  const o = owner(db.ownerUrl); await o.connect();
  for (const [company, email] of [['Alpha Co', 'a@example.test'], ['Beta Co', 'b@example.test']]) {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const id = (await o.query('SELECT id FROM tenants WHERE name=$1', [company])).rows[0].id;
    if (company === 'Alpha Co') A = { tenantId: id, email, cookie: cookieOf(res) }; else B = { tenantId: id, email, cookie: cookieOf(res) };
  }
  await o.query('UPDATE tenants SET viewing_reminders_auto=true WHERE id=$1', [A.tenantId]);
  await o.end();
});
test.after(async () => { await app.close(); await db.stop(); });

test('sends reminder for a viewing inside the window, marks it, never resends', async () => {
  const vid = await mkViewing(A.tenantId, 20);
  const r1 = await runViewingReminders({ fetchImpl: fakeFetch });
  assert.deepEqual(r1, [{ viewing: vid, status: 'sent' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], A.email);
  assert.match(sent[0].subject, /12 Oak Street/);
  assert.match(sent[0].text, /Sipho Dube/);
  assert.match(sent[0].text, /goes to you only/);
  const r2 = await runViewingReminders({ fetchImpl: fakeFetch });
  assert.deepEqual(r2, []);
  assert.equal(sent.length, 1);
  const marked = await withTenant(A.tenantId, (c) => c.query('SELECT reminder_sent_at FROM re_viewings WHERE id=$1', [vid]).then((r) => r.rows[0].reminder_sent_at));
  assert.ok(marked);
});

test('ignores viewings outside the window, done viewings, and opted-out tenants', async () => {
  await mkViewing(A.tenantId, 30); // beyond 24h
  const done = await mkViewing(A.tenantId, 10);
  await withTenant(A.tenantId, (c) => c.query("UPDATE re_viewings SET status='done' WHERE id=$1", [done]));
  await mkViewing(B.tenantId, 12); // Beta never opted in
  const r = await runViewingReminders({ fetchImpl: fakeFetch });
  assert.deepEqual(r, []);
  assert.equal(sent.length, 1); // still only the first one
});

test('daily cap releases the claim so the next tick can retry', async () => {
  const vid = await mkViewing(A.tenantId, 8, 'Thandi Mokoena');
  process.env.HI_EMAIL_DAILY_CAP = '1';
  try {
    const r = await runViewingReminders({ fetchImpl: fakeFetch });
    assert.deepEqual(r, [{ viewing: vid, status: 'daily cap reached' }]);
    assert.equal(sent.length, 1);
    const unclaimed = await withTenant(A.tenantId, (c) => c.query('SELECT reminder_sent_at FROM re_viewings WHERE id=$1', [vid]).then((r) => r.rows[0].reminder_sent_at));
    assert.equal(unclaimed, null);
  } finally {
    delete process.env.HI_EMAIL_DAILY_CAP;
  }
});

test('failed send releases the claim', async () => {
  // clear the still-pending viewing from the cap test so only the new one is due
  const clear = await runViewingReminders({ fetchImpl: fakeFetch });
  assert.equal(clear.length, 1);
  assert.equal(sent.length, 2);
  const vid = await mkViewing(A.tenantId, 6, 'Pieter Botha');
  const badFetch = async () => ({ ok: false, status: 500, json: async () => ({ message: 'provider down' }) });
  const r = await runViewingReminders({ fetchImpl: badFetch });
  assert.equal(r[0].viewing, vid);
  assert.equal(r[0].status, 'failed');
  const unclaimed = await withTenant(A.tenantId, (c) => c.query('SELECT reminder_sent_at FROM re_viewings WHERE id=$1', [vid]).then((r) => r.rows[0].reminder_sent_at));
  assert.equal(unclaimed, null);
  const ok = await runViewingReminders({ fetchImpl: fakeFetch });
  assert.deepEqual(ok, [{ viewing: vid, status: 'sent' }]);
  assert.equal(sent.length, 3);
});

test('settings toggle flips the tenant flag with csrf', async () => {
  const page = await app.inject({ url: '/app/settings', headers: { cookie: B.cookie } });
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1];
  assert.match(page.body, /viewing-reminders/);
  const on = await app.inject({ method: 'POST', url: '/app/settings/viewing-reminders', headers: { cookie: B.cookie, ...H }, payload: form({ csrf, on: 'true' }) });
  assert.equal(on.statusCode, 302);
  const flag = await withTenant(B.tenantId, (c) => c.query('SELECT viewing_reminders_auto FROM tenants WHERE id=current_setting(\'app.tenant_id\')::uuid').then((r) => r.rows[0].viewing_reminders_auto));
  assert.equal(flag, true);
  const bad = await app.inject({ method: 'POST', url: '/app/settings/viewing-reminders', headers: { cookie: B.cookie, ...H }, payload: form({ csrf: 'wrong', on: 'false' }) });
  assert.equal(bad.statusCode, 403);
});

test('settings desk status follows profile keywords through RLS', async () => {
  // Beta (no keywords): inactive
  const offPage = await app.inject({ url: '/app/settings', headers: { cookie: B.cookie } });
  assert.match(offPage.body, /Opportunity Desk: inactive until you set keywords in Profile/);
  // give Beta keywords: active (proves the flag reads through tenant context, not a null)
  await withTenant(B.tenantId, (c) => c.query("UPDATE profiles SET keywords=ARRAY['cleaning']"));
  const onPage = await app.inject({ url: '/app/settings', headers: { cookie: B.cookie } });
  assert.match(onPage.body, /Official tender open data: active/);
});

test('document expiry digest: thresholds advance, no resend, date edit resets, opt-out skipped', async () => {
  const { runDocExpiryReminders } = await import('../src/reminders.js');
  const o = owner(db.ownerUrl); await o.connect();
  await o.query('UPDATE tenants SET document_reminders_auto=true WHERE id=$1', [A.tenantId]);
  await o.end();
  const addDoc = (t, title, expiresOn) => withTenant(t, (c) => c.query(
    "INSERT INTO vault_docs (tenant_id, doc_type, title, expires_on) VALUES (current_setting('app.tenant_id')::uuid, 'PPRA Fidelity Fund Certificate', $1, $2) RETURNING id", [title, expiresOn]).then((r) => r.rows[0].id));
  const d30 = await addDoc(A.tenantId, 'FFC 2026', '+30d' && new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10));
  const d7 = await addDoc(A.tenantId, 'FICA licence', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10));
  const dOld = await addDoc(A.tenantId, 'Old FFC', new Date(Date.now() - 864e5).toISOString().slice(0, 10));
  await addDoc(A.tenantId, 'Far away', new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10));
  await addDoc(B.tenantId, 'Beta FFC', new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)); // Beta not opted in

  const before = sent.length;
  const r1 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].status, 'sent');
  assert.equal(r1[0].count, 3); // 30-day, 7-day and expired; the 90-day one is not due
  assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1].to[0], A.email);
  assert.match(sent[sent.length - 1].text, /FFC 2026/);
  assert.match(sent[sent.length - 1].text, /EXPIRED Old FFC/);
  // second sweep: nothing new
  const r2 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.deepEqual(r2, []);
  assert.equal(sent.length, before + 1);
  // editing the expiry date resets the stage and re-reminds at the right threshold
  await withTenant(A.tenantId, (c) => c.query('UPDATE vault_docs SET expires_on = $1 WHERE id = $2', [new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), d30]));
  const r3 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.equal(r3.length, 1);
  assert.equal(r3[0].count, 1); // only the edited doc
  assert.match(sent[sent.length - 1].text, /FFC 2026/);
});

test('document expiry digest: daily cap sends nothing and does not advance stages', async () => {
  const { runDocExpiryReminders } = await import('../src/reminders.js');
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO vault_docs (tenant_id, doc_type, title, expires_on) VALUES (current_setting('app.tenant_id')::uuid, 'Other', 'Capped doc', $1)", [new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)]));
  process.env.HI_EMAIL_DAILY_CAP = '1';
  try {
    const before = sent.length;
    const r = await runDocExpiryReminders({ fetchImpl: fakeFetch });
    assert.equal(r[0].status, 'daily cap reached');
    assert.equal(sent.length, before);
    const stage = await withTenant(A.tenantId, (c) => c.query("SELECT expiry_reminder_stage FROM vault_docs WHERE title='Capped doc'").then((x) => x.rows[0].expiry_reminder_stage));
    assert.equal(stage, 0);
  } finally {
    delete process.env.HI_EMAIL_DAILY_CAP;
  }
});

test('lease-end digest: same opt-in, stages advance, end-date edit resets, opt-out skipped', async () => {
  const { runDocExpiryReminders } = await import('../src/reminders.js');
  process.env.HI_EMAIL_DAILY_CAP = '50'; // earlier tests in this file already logged sends
  const o = owner(db.ownerUrl); await o.connect();
  await o.query('UPDATE tenants SET document_reminders_auto=true WHERE id=$1', [A.tenantId]);
  await o.end();
  const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const leaseId = await withTenant(A.tenantId, async (c) => {
    const p = (await c.query("INSERT INTO re_properties (tenant_id, title) VALUES (current_setting('app.tenant_id')::uuid, '44 Lease Lane') RETURNING id")).rows[0];
    return (await c.query("INSERT INTO re_leases (tenant_id, property_id, end_date, status) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'active') RETURNING id", [p.id, inDays(45)])).rows[0].id;
  });

  const before = sent.length;
  const r1 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].status, 'sent');
  assert.ok(r1[0].count >= 1); // the 45-day lease end plus any still-due docs from earlier tests
  assert.match(sent[sent.length - 1].subject, /Documents and lease ends: \d+ items? need attention/);
  assert.match(sent[sent.length - 1].text, /Lease 44 Lease Lane: ends .* \(45 days left\)/);
  assert.match(sent[sent.length - 1].text, /your own address only/);

  // second sweep: nothing new
  assert.deepEqual(await runDocExpiryReminders({ fetchImpl: fakeFetch }), []);
  assert.equal(sent.length, before + 1);

  // moving the end date resets the stage and re-reminds at the new threshold
  await withTenant(A.tenantId, (c) => c.query('UPDATE re_leases SET end_date = $1 WHERE id = $2', [inDays(25), leaseId]));
  const r3 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.equal(r3.length, 1);
  assert.match(sent[sent.length - 1].text, /25 days left/);

  // ended leases are marked ENDED; cancelled leases never remind
  await withTenant(A.tenantId, (c) => c.query('UPDATE re_leases SET end_date = $1 WHERE id = $2', [inDays(-2), leaseId]));
  const r4 = await runDocExpiryReminders({ fetchImpl: fakeFetch });
  assert.equal(r4.length, 1);
  assert.match(sent[sent.length - 1].text, /ENDED/);
  await withTenant(A.tenantId, (c) => c.query("UPDATE re_leases SET status='cancelled', end_date = $1 WHERE id = $2", [inDays(10), leaseId]));
  assert.deepEqual(await runDocExpiryReminders({ fetchImpl: fakeFetch }), []);

  // Beta (not opted in) never gets lease reminders
  await withTenant(B.tenantId, async (c) => {
    const p = (await c.query("INSERT INTO re_properties (tenant_id, title) VALUES (current_setting('app.tenant_id')::uuid, 'Beta Lease') RETURNING id")).rows[0];
    await c.query("INSERT INTO re_leases (tenant_id, property_id, end_date, status) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'active')", [p.id, inDays(20)]);
  });
  assert.deepEqual(await runDocExpiryReminders({ fetchImpl: fakeFetch }), []);
  delete process.env.HI_EMAIL_DAILY_CAP;
});
