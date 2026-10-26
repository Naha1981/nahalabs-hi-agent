import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { enc } from '../src/integrations.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B, cookieA, cookieB;
const llm = async () => ({ content: 'stub', tool_calls: [], model: 'stub' });
async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  await ensureDefaultAgent(tenantId);
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  return { tenantId, cookie: (login.headers['set-cookie'] || '').toString().split(';')[0] };
}

test.before(async () => {
  db = await startDb(54381); app = await buildApp({ llm });
  A = await mk('Alpha Estates', 'a@example.test'); B = await mk('Beta Holdings', 'b@example.test');
  await withTenant(A.tenantId, async (c) => {
    const link = (await c.query("INSERT INTO stripe_links (tenant_id, label, signing_secret_enc) VALUES (current_setting('app.tenant_id')::uuid,'NahaLabs store',$1) RETURNING id", [enc('whsec_reports')])).rows[0];
    await c.query("INSERT INTO stripe_events (tenant_id, link_id, event_id, payment_ref, type, amount_cents, currency, description) VALUES (current_setting('app.tenant_id')::uuid,$1,'evt_r1','pi_r1','payment_intent.succeeded',125000,'ZAR','Invoice 1042'),(current_setting('app.tenant_id')::uuid,$1,'evt_r2','pi_r2','charge.succeeded',42000,'ZAR','Retainer')", [link.id]);
    await c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sam')");
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','in','hi','received'),(current_setting('app.tenant_id')::uuid,'27829990001','in','still available?','received'),(current_setting('app.tenant_id')::uuid,'27829990001','out','Yes it is','sent')");
    await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'send_brief','brief','{}','agent:hi')");
    await c.query("INSERT INTO re_contacts (tenant_id, name, role) VALUES (current_setting('app.tenant_id')::uuid,'Sam Mokoena','buyer')");
  });
  await withTenant(B.tenantId, async (c) => {
    const link = (await c.query("INSERT INTO stripe_links (tenant_id, label, signing_secret_enc) VALUES (current_setting('app.tenant_id')::uuid,'Beta store',$1) RETURNING id", [enc('whsec_reports_b')])).rows[0];
    await c.query("INSERT INTO stripe_events (tenant_id, link_id, event_id, payment_ref, type, amount_cents, currency, description) VALUES (current_setting('app.tenant_id')::uuid,$1,'evt_b1','pi_b1','payment_intent.succeeded',999000,'ZAR','Beta invoice')", [link.id]);
  });
});
test.after(async () => { await app.close(); await db.stop(); });

test('reports page needs a login', async () => {
  const r = await app.inject({ url: '/app/reports' });
  assert.equal(r.statusCode, 302);
});

test('reports page shows only real recorded numbers', async () => {
  const page = await app.inject({ url: '/app/reports', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('ZAR 1670.00'), 'all-time total is the sum of the two real payments: ' + page.body.slice(0, 400));
  assert.ok(page.body.includes('2 payments'), 'payment count');
  assert.ok(page.body.includes('Invoice 1042') && page.body.includes('Retainer'), 'recent payments listed');
  assert.ok(page.body.includes('Saved contacts</td><td>1'), 'whatsapp contacts');
  assert.ok(page.body.includes('Messages in, last 7 days</td><td>2') && page.body.includes('Messages out, last 7 days</td><td>1'), 'message counts');
  assert.ok(page.body.includes('Waiting for you now</td><td>1'), 'pending approvals');
  assert.ok(page.body.includes('Clients</td><td>1'), 'estate clients');
  assert.ok(page.body.includes('Every number here comes from your own records'), 'honesty line');
  assert.ok(page.body.includes('Reports'), 'page title');
});

test('tenant isolation: another tenant\'s records never appear', async () => {
  const pa = await app.inject({ url: '/app/reports', headers: { cookie: A.cookie } });
  assert.ok(!pa.body.includes('9990.00') && !pa.body.includes('Beta invoice'), 'A never sees B payments');
  const pb = await app.inject({ url: '/app/reports', headers: { cookie: B.cookie } });
  assert.ok(pb.body.includes('ZAR 9990.00'), 'B sees its own payment');
  assert.ok(!pb.body.includes('Invoice 1042') && !pb.body.includes('Retainer'), 'B never sees A payments');
  assert.ok(pb.body.includes('Saved contacts</td><td>0'), 'B has no contacts');
});

test('empty sections are honest, never padded', async () => {
  const page = await app.inject({ url: '/app/reports', headers: { cookie: B.cookie } });
  assert.ok(page.body.includes('Messages in, last 7 days</td><td>0'), 'zero shown plainly');
  assert.ok(page.body.includes('Waiting for you now</td><td>0'), 'zero approvals shown plainly');
  assert.ok(page.body.includes('Clients</td><td>0'), 'zero clients shown plainly');
});
