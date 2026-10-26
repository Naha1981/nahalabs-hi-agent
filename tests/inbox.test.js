import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { decideApproval } from '../src/core.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
const J = { 'content-type': 'application/json' };
let db, app, A, B;
const llm = async () => ({ content: 'stub', tool_calls: [], model: 'stub' });
async function mk(company, email, waNumber) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  if (waNumber) await withTenant(tenantId, (c) => c.query('INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting(\'app.tenant_id\')::uuid,$1,$2)', [agent.id, waNumber]));
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  return { tenantId, cookie: (login.headers['set-cookie'] || '').toString().split(';')[0] };
}

test.before(async () => {
  db = await startDb(54389); app = await buildApp({ llm });
  A = await mk('Alpha Estates', 'a@example.test', '27821110001'); B = await mk('Beta Holdings', 'b@example.test');
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

test('inbox groups real messages into one row per person, named from contacts, honest about WhatsApp-only', async () => {
  const page = await app.inject({ url: '/app/inbox', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('Sam Mokoena'), 'contact name shown');
  assert.ok(page.body.includes('You: Yes it is, viewing Thursday?'), 'latest message preview with direction');
  assert.ok(page.body.includes('27829990002'), 'unnamed contact falls back to the number');
  assert.ok(page.body.includes('Them: pricing please'), 'second conversation present');
  assert.ok(!page.body.includes('spam'), 'ignored messages stay out of the inbox');
  assert.ok(page.body.includes('Instagram and Facebook messages cannot be received yet - that part is not built'), 'Meta receiving named as unbuilt');
  assert.ok(page.body.includes('Linking an account alone does not bring messages in'), 'no magic-connection implication');
  assert.ok(!page.body.includes('Every conversation with your business'), 'no false all-channels claim');
  assert.ok(page.body.includes('/app/inbox/27829990001'), 'conversation links through');
});

test('tenant isolation: other tenants never appear in the inbox', async () => {
  const pa = await app.inject({ url: '/app/inbox', headers: { cookie: A.cookie } });
  assert.ok(!pa.body.includes('beta secret conversation'), 'A never sees B');
  const pb = await app.inject({ url: '/app/inbox', headers: { cookie: B.cookie } });
  assert.ok(pb.body.includes('beta secret conversation'), 'B sees its own');
  assert.ok(!pb.body.includes('Sam Mokoena'), 'B never sees A');
});

test('conversation page shows the full thread in order with outbound statuses', async () => {
  const page = await app.inject({ url: '/app/inbox/27829990001', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('Chat with Sam Mokoena'));
  const inIdx = page.body.indexOf('Is the cottage still available?');
  const outIdx = page.body.indexOf('Yes it is, viewing Thursday?');
  assert.ok(inIdx > -1 && outIdx > inIdx, 'thread in chronological order');
  assert.ok(page.body.includes('sent'), 'outbound status shown');
  assert.ok(page.body.includes('/app/inbox/27829990001/reply'), 'reply form present');
  const other = await app.inject({ url: '/app/inbox/27829990001', headers: { cookie: B.cookie } });
  assert.ok(!other.body.includes('Is the cottage still available?'), 'B cannot read A thread');
});

test('owner reply: drafts into the approval queue with exact words; sends only after approval', async () => {
  const convo = await app.inject({ url: '/app/inbox/27829990001', headers: { cookie: A.cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(convo.body)[1];
  const r = await app.inject({ method: 'POST', url: '/app/inbox/27829990001/reply', headers: { cookie: A.cookie, ...H }, payload: form({ csrf, body: 'Thursday 14:00 works. See you then.' }) });
  assert.equal(r.statusCode, 302);
  assert.ok((r.headers.location || '').startsWith('/app/approvals'), 'lands on the approval queue');
  const ap = (await withTenant(A.tenantId, (c) => c.query("SELECT id, status, payload FROM approvals WHERE kind='whatsapp_reply' ORDER BY created_at DESC LIMIT 1"))).rows[0];
  assert.equal(ap.status, 'proposed');
  assert.equal(ap.payload.to, '27829990001');
  assert.equal(ap.payload.body, 'Thursday 14:00 works. See you then.', 'exact words bound to the approval');
  const msg = (await withTenant(A.tenantId, (c) => c.query('SELECT status FROM wa_messages WHERE id=$1', [ap.payload.wa_message_id]))).rows[0];
  assert.equal(msg.status, 'proposed', 'nothing sent yet');
  const owner = (await withTenant(A.tenantId, (c) => c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1"))).rows[0];
  const d = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'executed');
  const sent = (await withTenant(A.tenantId, (c) => c.query('SELECT status, body FROM wa_messages WHERE id=$1', [ap.payload.wa_message_id]))).rows[0];
  assert.equal(sent.status, 'sent');
  assert.equal(sent.body, 'Thursday 14:00 works. See you then.', 'exact approved words went out');
});

test('reply drafting fails closed without a linked WhatsApp number', async () => {
  await withTenant(B.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27811111111','Beta Person')"));
  const convo = await app.inject({ url: '/app/inbox/27811111111', headers: { cookie: B.cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(convo.body)[1];
  const r = await app.inject({ method: 'POST', url: '/app/inbox/27811111111/reply', headers: { cookie: B.cookie, ...H }, payload: form({ csrf, body: 'hello' }) });
  assert.equal(r.statusCode, 302);
  assert.ok(decodeURIComponent(r.headers.location || '').includes('No WhatsApp number is linked yet'), 'honest blocker, no fake draft');
  const n = (await withTenant(B.tenantId, (c) => c.query("SELECT count(*)::int n FROM approvals WHERE kind='whatsapp_reply'"))).rows[0].n;
  assert.equal(n, 0, 'no approval created without a channel');
});

test('empty inbox is honest', async () => {
  await withTenant(B.tenantId, (c) => c.query('DELETE FROM wa_messages'));
  const page = await app.inject({ url: '/app/inbox', headers: { cookie: B.cookie } });
  assert.ok(page.body.includes('No conversations yet'), 'honest empty state');
});
