import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B;
const llm = async () => ({ content: 'stub', tool_calls: [], model: 'stub' });
async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  await ensureDefaultAgent(tenantId);
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  return { tenantId, cookie: (login.headers['set-cookie'] || '').toString().split(';')[0] };
}

test.before(async () => {
  db = await startDb(54385); app = await buildApp({ llm });
  A = await mk('Alpha Estates', 'a@example.test'); B = await mk('Beta Holdings', 'b@example.test');
  await withTenant(A.tenantId, async (c) => {
    await c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sam Mokoena'),(current_setting('app.tenant_id')::uuid,'27829990002','')");
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','in','Is the cottage still available?','received'),(current_setting('app.tenant_id')::uuid,'27829990001','out','Yes it is, viewing Thursday?','sent'),(current_setting('app.tenant_id')::uuid,'27829990002','in','pricing please','received'),(current_setting('app.tenant_id')::uuid,'27829990009','in','spam','ignored')");
  });
  await withTenant(B.tenantId, async (c) => {
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,'27811111111','in','beta secret conversation','received')");
  });
});
test.after(async () => { await app.close(); await db.stop(); });

test('inbox needs a login', async () => {
  const r = await app.inject({ url: '/app/inbox' });
  assert.equal(r.statusCode, 302);
});

test('inbox groups real messages into one row per person, named from contacts', async () => {
  const page = await app.inject({ url: '/app/inbox', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('Sam Mokoena'), 'contact name shown');
  assert.ok(page.body.includes('you: Yes it is, viewing Thursday?'), 'latest message preview with direction');
  assert.ok(page.body.includes('27829990002'), 'unnamed contact falls back to the number');
  assert.ok(page.body.includes('them: pricing please'), 'second conversation present');
  assert.ok(!page.body.includes('spam'), 'ignored messages stay out of the inbox');
  assert.ok(page.body.includes('Instagram and Facebook messages are not connected yet'), 'Meta placeholders honest, no fake activity');
  assert.ok(page.body.includes('Only real messages appear here'), 'honesty line');
});

test('tenant isolation: other tenants never appear in the inbox', async () => {
  const pa = await app.inject({ url: '/app/inbox', headers: { cookie: A.cookie } });
  assert.ok(!pa.body.includes('beta secret conversation'), 'A never sees B');
  const pb = await app.inject({ url: '/app/inbox', headers: { cookie: B.cookie } });
  assert.ok(pb.body.includes('beta secret conversation'), 'B sees its own');
  assert.ok(!pb.body.includes('Sam Mokoena'), 'B never sees A');
});

test('empty inbox is honest', async () => {
  await withTenant(B.tenantId, (c) => c.query('DELETE FROM wa_messages'));
  const page = await app.inject({ url: '/app/inbox', headers: { cookie: B.cookie } });
  assert.ok(page.body.includes('No conversations yet'), 'honest empty state');
});
