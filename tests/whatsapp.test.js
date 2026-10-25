import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { normalisePhone, parseMetaWebhook, makeAdapter } from '../src/whatsapp.js';
import { decideApproval } from '../src/core.js';
import { createHash, createHmac } from 'node:crypto';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.WA_INBOUND_SECRET = 'wa-secret-for-tests'; delete process.env.GROQ_API_KEY;
process.env.WA_META_VERIFY_TOKEN = 'meta-verify-for-tests'; process.env.WA_META_APP_SECRET = 'meta-app-secret-for-tests';
process.env.WA_META_PHONE_NUMBER_ID = '1234567890'; process.env.WA_META_TOKEN = 'meta-token-for-tests';
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B, calls = 0;
const llm = async () => { calls++; return { content: 'Hello from HI', tool_calls: [], model: 'stub' }; };
async function mk(company, email, num) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  await withTenant(tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [agent.id, num]));
  return { tenantId, agentId: agent.id };
}
const inbound = (b, secret = 'wa-secret-for-tests') => app.inject({ method: 'POST', url: '/internal/wa/inbound', headers: { 'x-wa-secret': secret, 'content-type': 'application/json' }, payload: JSON.stringify(b) });
const rows = (u) => withTenant(u.tenantId, (c) => c.query('SELECT phone, direction, status FROM wa_messages ORDER BY id')).then((r) => r.rows);

test.before(async () => { db = await startDb(54325); app = await buildApp({ llm }); A = await mk('Alpha', 'a@example.test', '27821110001'); B = await mk('Beta', 'b@example.test', '27821110002');
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sipho')")); });
test.after(async () => { await app.close(); await db.stop(); });

test('phone normalisation', () => { assert.equal(normalisePhone('082 123 4567'), '27821234567'); assert.equal(normalisePhone('+27 82 123 4567'), '27821234567'); });

test('inbound needs the shared secret', async () => {
  assert.equal((await inbound({ to: '27821110001', from: '27829990001', text: 'hi' }, 'nope')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/wa/inbound', payload: {} })).statusCode, 401);
});

test('saved contact gets a draft reply; only an owner approval sends it; duplicates are ignored', async () => {
  const r = await inbound({ to: '27821110001', from: '27829990001', text: 'What tenders closed today?', id: 'm1' });
  const j = r.json(); assert.equal(j.queued, true); assert.equal(j.replied, false); assert.equal(j.reply, 'Hello from HI');
  const before = calls; const dup = (await inbound({ to: '27821110001', from: '27829990001', text: 'again', id: 'm1' })).json();
  assert.equal(dup.ignored, 'duplicate'); assert.equal(calls, before);
  assert.deepEqual((await rows(A)).map((m) => m.direction + ':' + m.status), ['in:received', 'out:queued']);
  const approval = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM approvals WHERE kind='wa_reply' ORDER BY created_at DESC LIMIT 1"))).rows[0];
  const userId = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM users WHERE tenant_id=current_setting('app.tenant_id')::uuid ORDER BY created_at LIMIT 1"))).rows[0].id;
  const sent = await decideApproval({ tenantId: A.tenantId, userId, userEmail: 'a@example.test', approvalId: approval.id, decision: 'approve', fetchImpl: async () => ({ ok: true }) });
  assert.equal(sent.status, 'executed');
  assert.deepEqual((await rows(A)).map((m) => m.direction + ':' + m.status), ['in:received', 'out:sent']);
});

test('unknown senders are logged and ignored, never answered; no cross-tenant routing', async () => {
  const before = calls;
  const r = (await inbound({ to: '27821110001', from: '27720000000', text: 'hello?', id: 'u1' })).json();
  assert.match(r.ignored, /not a saved contact/); assert.equal(calls, before);
  assert.ok((await rows(A)).some((m) => m.phone === '27720000000' && m.status === 'ignored'));
  // Beta's channel does not know Alpha's contact
  assert.match((await inbound({ to: '27821110002', from: '27829990001', text: 'hi', id: 'x1' })).json().ignored, /not a saved contact/);
  assert.equal((await rows(B)).filter((m) => m.direction === 'out').length, 0);
  assert.match((await inbound({ to: '27829998888', from: '27829990001', text: 'hi' })).json().ignored, /no active channel/);
});

test('paused tenant, emergency stop and rate limits silence replies; outreach lines cannot be channels', async () => {
  await withSystem((c) => c.query('UPDATE tenants SET paused=true WHERE id=$1', [A.tenantId]));
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p1' })).json().ignored, /no active channel/);
  await withSystem((c) => c.query('UPDATE tenants SET paused=false WHERE id=$1', [A.tenantId]));
  await withSystem((c) => c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop','on') ON CONFLICT (key) DO UPDATE SET value='on'"));
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p2' })).json().ignored, /emergency/);
  await withSystem((c) => c.query("UPDATE system_flags SET value='off' WHERE key='emergency_stop'"));
  process.env.WA_MAX_REPLIES_PER_TENANT_DAY = '1';
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p3' })).json().ignored, /rate limit/);
  delete process.env.WA_MAX_REPLIES_PER_TENANT_DAY;
  for (const n of ['27672347593', '27610000000']) await assert.rejects(withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [A.agentId, n])));
});

test('tenant isolation on WhatsApp tables', async () => {
  for (const t of ['wa_channels', 'wa_contacts', 'wa_messages']) assert.ok((await withTenant(B.tenantId, (c) => c.query(`SELECT tenant_id FROM ${t}`))).rows.every((r) => r.tenant_id === B.tenantId), t);
  await assert.rejects(withTenant(B.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone) VALUES ($1,'27821230000')", [A.tenantId])));
});

test('meta_cloud adapter posts a text message to the Graph API', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: true, status: 200 }; };
  const adapter = makeAdapter(fetchImpl);
  await adapter({ engine: 'meta_cloud', from: '27821110001', to: '27829990001', text: 'Your brief is ready' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(seen[0].opts.headers.authorization, 'Bearer meta-token-for-tests');
  const body = JSON.parse(seen[0].opts.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '27829990001');
  assert.equal(body.text.body, 'Your brief is ready');
  const bad = makeAdapter(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => bad({ engine: 'meta_cloud', from: '1', to: '2', text: 'x' }), /meta_cloud http 401/);
});

test('owner number needs a one-time code before owner privileges; its generated replies still queue', async () => {
  const codeHash = createHash('sha256').update('123456').digest('hex');
  await withTenant(A.tenantId, (c) => c.query(
    "UPDATE wa_channels SET owner_phone=$2, owner_verification_hash=$3, owner_verification_expires_at=now() + interval '10 minutes', owner_verification_attempts=0 WHERE number=$1",
    ['27821110001', '27829990002', codeHash]
  ));
  const wrongSender = (await inbound({ to: '27821110001', from: '27820000000', text: 'HI VERIFY 123456', id: 'verify-wrong' })).json();
  assert.match(wrongSender.ignored, /verification/);
  const verified = (await inbound({ to: '27821110001', from: '27829990002', text: 'HI VERIFY 123456', id: 'verify-ok' })).json();
  assert.equal(verified.owner_verified, true);
  const channel = (await withTenant(A.tenantId, (c) => c.query("SELECT owner_verified_at, owner_verification_hash FROM wa_channels WHERE number='27821110001'"))).rows[0];
  assert.ok(channel.owner_verified_at); assert.equal(channel.owner_verification_hash, null);
  const ownerReply = (await inbound({ to: '27821110001', from: '27829990002', text: 'Give me a summary', id: 'owner-command' })).json();
  assert.equal(ownerReply.queued, true);
  assert.equal(ownerReply.replied, false);
});

test('meta webhook GET verifies with the token', async () => {
  const ok = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=meta-verify-for-tests&hub.challenge=abc123' });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body, 'abc123');
  assert.equal((await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123' })).statusCode, 403);
});

test('meta webhook POST verifies the signature and delivers inbound text', async () => {
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '27821110001' },
    messages: [{ id: 'wamid.test1', from: '27829990001', type: 'text', text: { body: 'Any new matches?' } }, { id: 'st1', type: 'reaction' }] } }] }] });
  const sign = (secret, data) => 'sha256=' + createHmac('sha256', secret).update(data).digest('hex');
  assert.equal((await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('wrong-secret', payload) }, payload })).statusCode, 401);
  const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('meta-app-secret-for-tests', payload) }, payload });
  assert.equal(r.statusCode, 200); assert.equal(r.json().received, 1, 'reaction skipped');
  const msgs = await rows(A);
  assert.ok(msgs.some((m) => m.direction === 'in' && m.phone === '27829990001'), 'inbound stored');
  assert.ok(msgs.some((m) => m.direction === 'out'), 'reply stored');
});

test('parseMetaWebhook ignores statuses and non-text', () => {
  assert.deepEqual(parseMetaWebhook({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '2782' }, statuses: [{ id: 'x' }] } }] }] }), []);
  assert.deepEqual(parseMetaWebhook({}), []);
});
