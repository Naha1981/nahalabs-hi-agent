import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { audit } from '../src/db.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.WA_INBOUND_SECRET = 'wa-secret-for-tests'; delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B;
const llm = async () => ({ content: 'Hello', tool_calls: [], model: 'stub' });
async function mk(company, email, num) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  await withTenant(tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [agent.id, num]));
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  return { tenantId, cookie: (login.headers['set-cookie'] || '').toString().split(';')[0] };
}
const inbound = (b) => app.inject({ method: 'POST', url: '/internal/wa/inbound', headers: { 'x-wa-secret': 'wa-secret-for-tests', 'content-type': 'application/json' }, payload: JSON.stringify(b) });
const get = (u, path) => app.inject({ method: 'GET', url: path, headers: { cookie: u.cookie } }).then((r) => ({ status: r.statusCode, body: r.body }));

test.before(async () => {
  db = await startDb(54327); app = await buildApp({ llm });
  A = await mk('Notif A', 'na@example.test', '27821110011'); B = await mk('Notif B', 'nb@example.test', '27821110012');
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990011','Naledi')"));
});
test.after(async () => { await app.close(); await db.stop(); });

test('a real inbound customer message records a notification event', async () => {
  const r = await inbound({ to: '27821110011', from: '27829990011', text: 'Hi, is this still available?', id: 'notif-wa-1' });
  assert.equal(r.statusCode, 200);
  const rows = await withTenant(A.tenantId, (c) => c.query("SELECT action FROM audit_log WHERE action='wa.message_received'")).then((r2) => r2.rows);
  assert.equal(rows.length, 1);
});

test('feed shows the real event, unread badge in the nav, and NEW marker', async () => {
  await withTenant(A.tenantId, (c) => audit(c, A.tenantId, 'system', 'stripe.payment_received', { type: 'rent', amount_cents: 950000, currency: 'zar' }));
  const page = await get(A, '/app/agent');
  assert.match(page.body, /Notifications <span[^>]*>2<\/span>/);
  const feed = await get(A, '/app/notifications');
  assert.match(feed.body, /WhatsApp message from 27829990011/);
  assert.match(feed.body, /Payment received: zar 9500\.00/);
  assert.match(feed.body, /<b>NEW<\/b>/);
});

test('mark all as read resets the badge; a new event brings it back', async () => {
  const home = await get(A, '/app/agent');
  const csrf = (home.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  const r = await app.inject({ method: 'POST', url: '/app/notifications/read', headers: { cookie: A.cookie, ...H }, payload: form({ csrf }) });
  assert.equal(r.statusCode, 302);
  const after = await get(A, '/app/notifications');
  assert.doesNotMatch(after.body, /<b>NEW<\/b>/);
  const nav = await get(A, '/app/agent');
  assert.doesNotMatch(nav.body, /Notifications <span/);
  await inbound({ to: '27821110011', from: '27829990011', text: 'Any update?', id: 'notif-wa-2' });
  const again = await get(A, '/app/agent');
  assert.match(again.body, /Notifications <span[^>]*>1<\/span>/);
});

test('mark-read needs the CSRF token', async () => {
  const r = await app.inject({ method: 'POST', url: '/app/notifications/read', headers: { cookie: A.cookie, ...H }, payload: form({}) });
  assert.equal(r.statusCode, 403);
});

test('tenant isolation: B sees only its own events and an honest empty state', async () => {
  const feed = await get(B, '/app/notifications');
  assert.equal(feed.status, 200);
  assert.doesNotMatch(feed.body, /27829990011/);
  assert.match(feed.body, /Nothing yet/);
  const nav = await get(B, '/app/agent');
  assert.doesNotMatch(nav.body, /Notifications <span/);
});

test('notifications need a login', async () => {
  const r = await app.inject({ method: 'GET', url: '/app/notifications' });
  assert.equal(r.statusCode, 302);
});
