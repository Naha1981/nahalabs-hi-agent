import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { normalisePhone } from '../src/whatsapp.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.WA_INBOUND_SECRET = 'wa-secret-for-tests'; delete process.env.GROQ_API_KEY;
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

test('saved contact gets a reply; reply is stored; duplicates are ignored', async () => {
  const r = await inbound({ to: '27821110001', from: '27829990001', text: 'What tenders closed today?', id: 'm1' });
  const j = r.json(); assert.equal(j.replied, true); assert.equal(j.reply, 'Hello from HI');
  const before = calls; const dup = (await inbound({ to: '27821110001', from: '27829990001', text: 'again', id: 'm1' })).json();
  assert.equal(dup.ignored, 'duplicate'); assert.equal(calls, before);
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
