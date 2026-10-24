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
