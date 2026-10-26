import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runTool } from '../src/tools.js';
import { decideApproval } from '../src/core.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A;
const llm = async () => ({ content: 'stub', tool_calls: [], model: 'stub' });
const ownerOf = async (t) => (await withTenant(t, (c) => c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1"))).rows[0];

test.before(async () => {
  db = await startDb(54340); app = await buildApp({ llm });
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Alpha', email: 'a@example.test', password: 'a-long-test-password-1' }) });
  A = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', ['a@example.test']))).rows[0].tenant_id;
});
test.after(async () => { await app.close(); await db.stop(); });

const propose = (name, args) => withTenant(A, (c) => runTool(name, args, { c, tenantId: A, userEmail: 'a@example.test', agentName: 'hi', principal: 'owner' }));
const lastApproval = () => withTenant(A, (c) => c.query('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 1')).then((r) => r.rows[0]);

test('propose_social_post drafts only; approve fails closed without a connected account', async () => {
  const r = await propose('propose_social_post', { network: 'facebook', text: 'Just listed: 2-bed garden cottage in Kyalami, R12,500/m. Message to view.' });
  assert.match(String(r), /approval queue/);
  const ap = await lastApproval();
  assert.equal(ap.kind, 'social_post'); assert.equal(ap.status, 'proposed');
  assert.equal(ap.payload.network, 'facebook');
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'failed'); assert.match(d.reason, /not connected yet/, 'no fake publish: fails closed');
});

test('social_post publishes exactly the approved text once credentials exist (stub Graph API)', async () => {
  process.env.META_PAGE_ID = 'page-1'; process.env.META_PAGE_TOKEN = 'tok';
  const r = await propose('propose_social_post', { network: 'facebook', text: 'Saturday show house, 10:30, Kyalami.' });
  assert.match(String(r), /approval queue/);
  const ap = await lastApproval();
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ id: 'c1' }) }; };
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/page-1/feed');
  assert.equal(JSON.parse(seen[0].opts.body).message, 'Saturday show house, 10:30, Kyalami.', 'exact approved words go out');
  delete process.env.META_PAGE_ID; delete process.env.META_PAGE_TOKEN;
});

test('instagram without a media link fails validation, never publishes', async () => {
  process.env.META_PAGE_ID = 'page-1'; process.env.META_PAGE_TOKEN = 'tok';
  const r = await propose('propose_social_post', { network: 'instagram', text: 'Pretty kitchen' });
  const ap = await lastApproval();
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'failed'); assert.match(d.reason, /image or video link/);
  delete process.env.META_PAGE_ID; delete process.env.META_PAGE_TOKEN;
});

test('propose_ad_campaign drafts; approve fails closed without an ads account; google is honest about not being wired', async () => {
  const r = await propose('propose_ad_campaign', { network: 'meta', headline: 'Kyalami cottage to let', body: 'Garden cottage, R12,500/m.', audience: 'Sandton, 25-45', daily_budget_cents: 15000, currency: 'zar' });
  assert.match(String(r), /approval queue/);
  const ap = await lastApproval();
  assert.equal(ap.kind, 'ad_campaign_draft');
  assert.equal(ap.payload.daily_budget_cents, 15000); assert.equal(ap.payload.currency, 'ZAR');
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'failed'); assert.match(d.reason, /not connected yet/, 'no fake campaign');
  const r2 = await propose('propose_ad_campaign', { network: 'google', headline: 'h', body: 'b', daily_budget_cents: 1000, currency: 'ZAR' });
  const ap2 = await lastApproval();
  const d2 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap2.id, decision: 'approve' });
  assert.equal(d2.status, 'failed'); assert.match(d2.reason, /not wired yet/);
});

test('meta ad campaign is created PAUSED once credentials exist (stub Graph API)', async () => {
  process.env.META_AD_ACCOUNT_ID = '123'; process.env.META_ADS_TOKEN = 'tok';
  await propose('propose_ad_campaign', { network: 'meta', headline: 'Kyalami cottage to let', body: 'b', daily_budget_cents: 15000, currency: 'ZAR' });
  const ap = await lastApproval();
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ id: 'camp1' }) }; };
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  assert.equal(seen.length, 1);
  const body = JSON.parse(seen[0].opts.body);
  assert.equal(body.status, 'PAUSED', 'money never moves on approval alone');
  assert.equal(body.daily_budget, 15000);
  delete process.env.META_AD_ACCOUNT_ID; delete process.env.META_ADS_TOKEN;
});

test('emergency stop cancels social and ad approvals at decision time', async () => {
  process.env.META_PAGE_ID = 'page-1'; process.env.META_PAGE_TOKEN = 'tok';
  await propose('propose_social_post', { network: 'facebook', text: 'stop test' });
  const ap = await lastApproval();
  await withSystem((c) => c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop','on') ON CONFLICT (key) DO UPDATE SET value='on'"));
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'cancelled');
  await withSystem((c) => c.query("UPDATE system_flags SET value='off' WHERE key='emergency_stop'"));
  delete process.env.META_PAGE_ID; delete process.env.META_PAGE_TOKEN;
});
