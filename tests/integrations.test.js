import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { decideApproval } from '../src/core.js';
import { mailSearch, calendarUpcoming } from '../src/integrations.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.HI_EMAIL_DAILY_CAP = '5';
process.env.SEARX_URL = 'https://searx.example.test';
process.env.INTEGRATIONS_SECRET = 'test-integrations-secret-0123456789abcdef';
process.env.GOOGLE_CLIENT_ID = 'google-test-client';
process.env.GOOGLE_CLIENT_SECRET = 'google-test-secret';
process.env.PUBLIC_BASE_URL = 'https://hi.example.test';
delete process.env.GROQ_API_KEY;

let db, app;
const llm = async () => ({ content: 'done', tool_calls: [] });
const calls = [];
const fakeFetch = async (url, opts = {}) => {
  url = String(url); calls.push({ url, body: opts.body });
  const json = (j) => ({ ok: true, status: 200, json: async () => j });
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'g-access-1', refresh_token: 'g-refresh-1', expires_in: 3600 });
  if (url.includes('openidconnect.googleapis.com')) return json({ email: 'alpha@gmail.test' });
  if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) return json({ id: 'gmail-sent-1' });
  if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages?')) return json({ messages: [{ id: 'm1' }] });
  if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/m1')) return json({ snippet: 'Quote for cleaning', payload: { headers: [{ name: 'Subject', value: 'Cleaning quote' }, { name: 'From', value: 'client@corp.test' }, { name: 'Date', value: 'Fri, 17 Oct 2026' }] } });
  if (url.includes('googleapis.com/calendar/v3/calendars/primary/events') && opts.method === 'POST') return json({ id: 'evt-1' });
  if (url.includes('googleapis.com/calendar/v3/calendars/primary/events')) return json({ items: [{ summary: 'Site visit', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' }, location: 'Gauteng' }] });
  throw new Error('unexpected fetch ' + url);
};
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  const cookie = cookieOf(res);
  const page = await app.inject({ url: '/app/integrations', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id, id FROM users WHERE email=$1', [email]))).rows[0];
  return { cookie, csrf, tenantId: tenantId.tenant_id, userId: tenantId.id, email };
}

let A, B;
test.before(async () => { db = await startDb(54325); app = await buildApp({ fetchImpl: fakeFetch, llm, lookup: async () => [{ address: '93.184.216.34' }] }); A = await mk('Alpha Co', 'a@example.test'); B = await mk('Beta Co', 'b@example.test'); });
test.after(async () => { await app.close(); await db.stop(); });

test('Google OAuth start redirects to Google with state, callback connects and stores encrypted tokens', async () => {
  const start = await app.inject({ url: '/integrations/google/start', headers: { cookie: A.cookie } });
  assert.equal(start.statusCode, 302);
  const loc = new URL(start.headers.location);
  assert.equal(loc.hostname, 'accounts.google.com');
  const state = loc.searchParams.get('state');
  assert.match(loc.searchParams.get('scope'), /gmail.readonly/);
  const cb = await app.inject({ url: `/integrations/google/callback?code=fake-code&state=${encodeURIComponent(state)}`, headers: { cookie: A.cookie } });
  assert.equal(cb.statusCode, 302);
  assert.match(cb.headers.location, /Connected%20alpha%40gmail.test/);
  const row = await withTenant(A.tenantId, (c) => c.query('SELECT account_email, access_token_enc, refresh_token_enc FROM integrations').then((r) => r.rows[0]));
  assert.equal(row.account_email, 'alpha@gmail.test');
  assert.ok(row.access_token_enc && !row.access_token_enc.includes('g-access-1'), 'token stored encrypted');
  assert.ok(row.refresh_token_enc && !row.refresh_token_enc.includes('g-refresh-1'), 'refresh token stored encrypted');
  // tenant B sees nothing
  const bRows = await withTenant(B.tenantId, (c) => c.query('SELECT count(*)::int n FROM integrations').then((r) => r.rows[0].n));
  assert.equal(bRows, 0);
});

test('bad state is rejected', async () => {
  const cb = await app.inject({ url: '/integrations/google/callback?code=x&state=bad-state', headers: { cookie: A.cookie } });
  assert.match(cb.headers.location, /did%20not%20match/);
});

test('mail search and upcoming calendar read the connected account', async () => {
  const mail = await mailSearch(A.tenantId, { query: 'quote', fetchImpl: fakeFetch });
  assert.equal(mail[0].subject, 'Cleaning quote');
  assert.equal(mail[0].account, 'alpha@gmail.test');
  const cal = await calendarUpcoming(A.tenantId, { fetchImpl: fakeFetch });
  assert.equal(cal[0].title, 'Site visit');
  // tenant B has no connections
  assert.deepEqual(await mailSearch(B.tenantId, { fetchImpl: fakeFetch }), []);
});

test('connected-account email send is approval-gated and executes from the connected Gmail', async () => {
  const integ = await withTenant(A.tenantId, (c) => c.query('SELECT id FROM integrations').then((r) => r.rows[0]));
  const { proposeAccountEmail } = await import('../src/integrations.js');
  const ap = await withTenant(A.tenantId, (c) => proposeAccountEmail(c, { tenantId: A.tenantId, integrationId: integ.id, to: 'client@corp.test', subject: 'Your cleaning quote', body: 'Hello, quote attached.', actor: 'agent:hi' }));
  assert.ok(ap.approval_id);
  const before = calls.length;
  const r = await decideApproval({ tenantId: A.tenantId, userId: A.userId, userEmail: A.email, approvalId: ap.approval_id, decision: 'approve', fetchImpl: fakeFetch });
  assert.equal(r.status, 'executed');
  const send = calls.slice(before).find((x) => x.url.includes('messages/send'));
  assert.ok(send, 'gmail send called after approval');
  const raw = Buffer.from(JSON.parse(send.body).raw, 'base64url').toString();
  assert.match(raw, /To: client@corp\.test/);
  // reject path: nothing sends
  const ap2 = await withTenant(A.tenantId, (c) => proposeAccountEmail(c, { tenantId: A.tenantId, integrationId: integ.id, to: 'x@y.test', subject: 'S', body: 'B', actor: 'agent:hi' }));
  const n2 = calls.length;
  const rr = await decideApproval({ tenantId: A.tenantId, userId: A.userId, userEmail: A.email, approvalId: ap2.approval_id, decision: 'reject', fetchImpl: fakeFetch });
  assert.equal(rr.status, 'rejected');
  assert.ok(!calls.slice(n2).some((x) => x.url.includes('messages/send')), 'no send on reject');
});

test('calendar event create is approval-gated', async () => {
  const integ = await withTenant(A.tenantId, (c) => c.query('SELECT id FROM integrations').then((r) => r.rows[0]));
  const { proposeCalendarEvent } = await import('../src/integrations.js');
  const ap = await withTenant(A.tenantId, (c) => proposeCalendarEvent(c, { tenantId: A.tenantId, integrationId: integ.id, title: 'Site visit prep', startsAt: '2026-10-20T08:00:00Z', endsAt: '2026-10-20T09:00:00Z', actor: 'agent:hi' }));
  const n = calls.length;
  const r = await decideApproval({ tenantId: A.tenantId, userId: A.userId, userEmail: A.email, approvalId: ap.approval_id, decision: 'approve', fetchImpl: fakeFetch });
  assert.equal(r.status, 'executed');
  const create = calls.slice(n).find((x) => x.url.includes('calendar/v3/calendars/primary/events') );
  assert.ok(create, 'calendar create called after approval');
  assert.match(create.body, /Site visit prep/);
});

test('disconnect deletes the stored tokens', async () => {
  const integ = await withTenant(A.tenantId, (c) => c.query('SELECT id FROM integrations').then((r) => r.rows[0]));
  const res = await app.inject({ method: 'POST', url: `/app/integrations/${integ.id}/disconnect`, headers: { cookie: A.cookie, ...H }, payload: form({ csrf: A.csrf }) });
  assert.equal(res.statusCode, 302);
  const left = await withTenant(A.tenantId, (c) => c.query('SELECT count(*)::int n FROM integrations').then((r) => r.rows[0].n));
  assert.equal(left, 0);
});
