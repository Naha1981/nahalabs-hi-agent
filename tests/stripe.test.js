import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { verifyStripeSignature } from '../src/stripe.js';
import { enc } from '../src/integrations.js';
import { decideApproval } from '../src/core.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
process.env.INTEGRATIONS_SECRET = 'integrations-secret-for-tests-0123456789';
const SECRET = 'whsec_testsecret123';
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B, gmailCalls;

const llm = async () => ({ content: 'stub', tool_calls: [], model: 'stub' });
const fetchImpl = async (url, opts) => { gmailCalls.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ id: 'gmail-1' }) }; };

async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  return (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
}
const mkLink = async (tenantId, withSecret = true) => (await withTenant(tenantId, (c) => c.query(
  'INSERT INTO stripe_links (tenant_id, label, signing_secret_enc) VALUES (current_setting(\'app.tenant_id\')::uuid, $1, $2) RETURNING id, token',
  ['store', withSecret ? enc(SECRET) : null]))).rows[0];
const sign = (secret, payload, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const post = (token, payload, sig) => app.inject({ method: 'POST', url: `/webhooks/stripe/${token}`, headers: { 'content-type': 'application/json', 'stripe-signature': sig }, payload });

test.before(async () => {
  db = await startDb(54335); app = await buildApp({ llm, fetchImpl });
  A = await mk('Alpha', 'a@example.test'); B = await mk('Beta', 'b@example.test');
});
test.after(async () => { await app.close(); await db.stop(); });
test.beforeEach(() => { gmailCalls = []; });

test('signature verification: valid, wrong secret, stale timestamp, malformed', () => {
  const payload = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(Buffer.from(payload), sign(SECRET, payload), SECRET), true);
  assert.equal(verifyStripeSignature(Buffer.from(payload), sign('whsec_wrong', payload), SECRET), false);
  assert.equal(verifyStripeSignature(Buffer.from(payload), sign(SECRET, payload, Math.floor(Date.now() / 1000) - 600), SECRET), false);
  assert.equal(verifyStripeSignature(Buffer.from(payload), 'garbage', SECRET), false);
  assert.equal(verifyStripeSignature(Buffer.from(payload), '', SECRET), false);
});

test('unknown or malformed endpoint tokens are rejected', async () => {
  const payload = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { amount_received: 100, currency: 'zar' } } });
  assert.equal((await post('not-a-uuid', payload, sign(SECRET, payload))).statusCode, 404);
  assert.equal((await post('00000000-0000-0000-0000-000000000000', payload, sign(SECRET, payload))).statusCode, 404);
});

test('a valid payment is recorded once; retries are deduplicated; other types ignored', async () => {
  const link = await mkLink(A);
  const payload = JSON.stringify({ id: 'evt_pay_1', type: 'payment_intent.succeeded', data: { object: { amount_received: 125000, currency: 'zar', description: 'Invoice 1042' } } });
  assert.equal((await post(link.token, payload, sign('whsec_wrong', payload))).statusCode, 401, 'bad signature rejected');
  const r = await post(link.token, payload, sign(SECRET, payload));
  assert.equal(r.statusCode, 200); assert.equal(r.json().recorded, true); assert.equal(r.json().emailed, false, 'no email while toggle off');
  const dup = await post(link.token, payload, sign(SECRET, payload));
  assert.equal(dup.json().dup, true);
  const rows = (await withTenant(A, (c) => c.query('SELECT event_id, type, amount_cents, currency, description FROM stripe_events'))).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].event_id, rows[0].type, Number(rows[0].amount_cents), rows[0].currency, rows[0].description], ['evt_pay_1', 'payment_intent.succeeded', 125000, 'ZAR', 'Invoice 1042']);
  const other = JSON.stringify({ id: 'evt_other', type: 'payment_intent.created', data: { object: {} } });
  assert.equal((await post(link.token, other, sign(SECRET, other))).json().ignored, 'not a payment receipt type');
  assert.equal((await withTenant(A, (c) => c.query('SELECT count(*)::int n FROM stripe_events'))).rows[0].n, 1);
  assert.equal(gmailCalls.length, 0, 'nothing sent anywhere');
});

test('link without a signing secret refuses deliveries until it is set', async () => {
  const link = await mkLink(A, false);
  const payload = JSON.stringify({ id: 'evt_nosec', type: 'charge.succeeded', data: { object: { amount: 500, currency: 'usd' } } });
  assert.equal((await post(link.token, payload, sign(SECRET, payload))).statusCode, 503);
});

test('opt-in toggle drafts the owner email but nothing sends without a click in Approvals', async () => {
  const link = await mkLink(A);
  await withSystem((c) => c.query('UPDATE tenants SET stripe_notifications_auto=true WHERE id=$1', [A]));
  await withTenant(A, (c) => c.query("INSERT INTO integrations (tenant_id, provider, account_email, scopes, access_token_enc, expires_at, status) VALUES (current_setting('app.tenant_id')::uuid,'google','a@example.test','',$1, now() + interval '1 hour','active')", [enc('fake-access-token')]));
  const payload = JSON.stringify({ id: 'evt_pay_2', type: 'charge.succeeded', data: { object: { amount: 42000, currency: 'zar', description: 'Retainer' } } });
  const r = await post(link.token, payload, sign(SECRET, payload));
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().approval_pending, JSON.stringify(r.json()));
  const ap = (await withTenant(A, (c) => c.query("SELECT id, kind, status, proposed_by, payload FROM approvals WHERE proposed_by='system:stripe'"))).rows;
  assert.equal(ap.length, 1); assert.equal(ap[0].kind, 'account_email'); assert.equal(ap[0].status, 'proposed', 'waits for the owner, never auto-sent');
  assert.equal(ap[0].payload.to, 'a@example.test', 'owner address only');
  assert.match(ap[0].payload.subject, /ZAR 420\.00/);
  assert.equal(gmailCalls.length, 0, 'no send before approval');
  const owner = (await withTenant(A, (c) => c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1"))).rows[0];
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap[0].id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  assert.equal(gmailCalls.length, 1, 'exactly one send, after the click');
  assert.equal(gmailCalls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  await withSystem((c) => c.query('UPDATE tenants SET stripe_notifications_auto=false WHERE id=$1', [A]));
});

test('one payment across checkout/payment_intent/charge events is recorded once', async () => {
  const link = await mkLink(A);
  const pi = 'pi_shared_123';
  const payloads = [
    { id: 'evt_cs', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_intent: pi, payment_status: 'paid', amount_total: 9900, currency: 'zar' } } },
    { id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: pi, amount_received: 9900, currency: 'zar' } } },
    { id: 'evt_ch', type: 'charge.succeeded', data: { object: { id: 'ch_1', payment_intent: pi, amount: 9900, currency: 'zar' } } },
  ];
  const results = [];
  for (const p of payloads) { const j = JSON.stringify(p); results.push((await post(link.token, j, sign(SECRET, j))).json()); }
  assert.equal(results.filter((x) => x.recorded).length, 1, JSON.stringify(results));
  assert.equal(results.filter((x) => x.dup && x.same_payment).length, 2, 'the other two event types dedupe to the same payment');
  const n = (await withTenant(A, (c) => c.query("SELECT count(*)::int n FROM stripe_events WHERE payment_ref=$1", [pi]))).rows[0].n;
  assert.equal(n, 1);
});

test('refunded charges and unpaid checkout sessions are not recorded as receipts', async () => {
  const link = await mkLink(A);
  const refunded = JSON.stringify({ id: 'evt_ref', type: 'charge.succeeded', data: { object: { id: 'ch_r', amount: 500, currency: 'zar', refunded: true, amount_refunded: 500 } } });
  assert.equal((await post(link.token, refunded, sign(SECRET, refunded))).json().ignored, 'not a completed payment');
  const unpaid = JSON.stringify({ id: 'evt_unp', type: 'checkout.session.completed', data: { object: { id: 'cs_u', payment_status: 'unpaid', amount_total: 500, currency: 'zar' } } });
  assert.equal((await post(link.token, unpaid, sign(SECRET, unpaid))).json().ignored, 'not a completed payment');
  const n = (await withTenant(A, (c) => c.query("SELECT count(*)::int n FROM stripe_events WHERE event_id IN ('evt_ref','evt_unp')"))).rows[0].n;
  assert.equal(n, 0, 'neither stored');
});

test('tenant isolation on stripe tables', async () => {
  for (const tbl of ['stripe_links', 'stripe_events']) {
    assert.ok((await withTenant(B, (c) => c.query(`SELECT tenant_id FROM ${tbl}`))).rows.every((r) => r.tenant_id === B), tbl);
  }
  await assert.rejects(withTenant(B, (c) => c.query("INSERT INTO stripe_links (tenant_id, label) VALUES ($1, 'x')", [A])));
  // Beta cannot read Alpha's events even via a forged link_id insert
  await assert.rejects(withTenant(B, (c) => c.query("INSERT INTO stripe_events (tenant_id, link_id, event_id, type) VALUES (current_setting('app.tenant_id')::uuid, (SELECT id FROM stripe_links LIMIT 1), 'e', 't')")));
});
