import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runTool } from '../src/tools.js';
import { decideApproval } from '../src/core.js';
import { enc } from '../src/integrations.js';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; delete process.env.GROQ_API_KEY;
process.env.INTEGRATIONS_SECRET = 'integrations-secret-for-tests-0123456789';
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
  // NOTE: credentials are set BEFORE drafting, so the draft binds to page:page-1.
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

test('drafts bind to the account connected at draft time; a changed or newly connected account fails closed', async () => {
  // Drafted while unconfigured: account_ref page:unconfigured
  await propose('propose_social_post', { network: 'facebook', text: 'bound draft' });
  const ap0 = await lastApproval();
  assert.equal(ap0.payload.account_ref, 'page:unconfigured');
  process.env.META_PAGE_ID = 'page-1'; process.env.META_PAGE_TOKEN = 'tok';
  const owner = await ownerOf(A);
  const d0 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap0.id, decision: 'approve' });
  assert.equal(d0.status, 'failed'); assert.match(d0.reason, /re-draft/, 'connecting an account after drafting cannot smuggle the old draft onto it');
  // Drafted against page-1, then the connected page changes
  await propose('propose_social_post', { network: 'facebook', text: 'second draft' });
  const ap1 = await lastApproval();
  assert.equal(ap1.payload.account_ref, 'page:page-1');
  process.env.META_PAGE_ID = 'page-2';
  const d1 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap1.id, decision: 'approve' });
  assert.equal(d1.status, 'failed'); assert.match(d1.reason, /changed since this draft/);
  process.env.META_PAGE_ID = 'page-1';
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

test('propose_ad_campaign drafts; approval fails closed when the account was connected after drafting', async () => {
  const r = await propose('propose_ad_campaign', { network: 'meta', headline: 'Kyalami cottage to let', body: 'Garden cottage, R12,500/m.', audience: 'Sandton, 25-45', daily_budget_cents: 15000, currency: 'zar' });
  assert.match(String(r), /approval queue/);
  const ap = await lastApproval();
  assert.equal(ap.kind, 'ad_campaign_draft');
  assert.equal(ap.payload.daily_budget_cents, 15000); assert.equal(ap.payload.currency, 'ZAR');
  assert.equal(ap.payload.account_ref, 'meta:unconfigured', 'draft binds to the account state at draft time');
  process.env.META_AD_ACCOUNT_ID = 'acct-1'; process.env.META_ADS_TOKEN = 'tok'; process.env.META_PAGE_ID = 'page-1'; process.env.HI_META_ADS_API_VERIFIED = '1';
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d.status, 'failed'); assert.match(d.reason, /re-draft/, 'no fake campaign, no silent account switch');
  delete process.env.META_AD_ACCOUNT_ID; delete process.env.META_ADS_TOKEN; delete process.env.META_PAGE_ID; delete process.env.HI_META_ADS_API_VERIFIED;
});

test('meta execution is gated: credentials alone never enable unverified calls; the draft is retained', async () => {
  process.env.META_AD_ACCOUNT_ID = 'acct-1'; process.env.META_ADS_TOKEN = 'tok'; process.env.META_PAGE_ID = 'page-1';
  await propose('propose_ad_campaign', { network: 'meta', headline: 'Kyalami cottage to let', body: 'Garden cottage, R12,500/m.', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/listing' });
  const ap = await lastApproval();
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'failed');
  assert.match(d.reason, /not verified against official Meta documentation/, 'gate names the real reason');
  assert.match(d.reason, /Nothing was sent/, 'honest that no campaign exists');
  assert.equal(called, 0, 'not a single outbound call while unverified, even with credentials present');
  const kept = (await withTenant(A, (c) => c.query('SELECT status, payload FROM approvals WHERE id=$1', [ap.id]))).rows[0];
  assert.equal(kept.status, 'failed');
  assert.equal(kept.payload.headline, 'Kyalami cottage to let', 'approved draft retained in full');
  delete process.env.META_AD_ACCOUNT_ID; delete process.env.META_ADS_TOKEN; delete process.env.META_PAGE_ID;
});

test('meta chain creates campaign, ad set, creative, ad - all PAUSED - exactly from the approved payload (stub Graph API)', async () => {
  process.env.META_AD_ACCOUNT_ID = 'acct-1'; process.env.META_ADS_TOKEN = 'tok'; process.env.META_PAGE_ID = 'page-1'; process.env.HI_META_ADS_API_VERIFIED = '1';
  await propose('propose_ad_campaign', { network: 'meta', headline: 'Kyalami cottage to let', body: 'Garden cottage, R12,500/m.', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/listing' });
  const ap = await lastApproval();
  assert.equal(ap.payload.account_ref, 'meta:acct-1');
  const seen = [];
  let n = 0;
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ id: 'id' + (++n) }) }; };
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  assert.deepEqual(seen.map((x) => x.url.split('/').pop()), ['campaigns', 'adsets', 'adcreatives', 'ads']);
  assert.equal(seen[0].body.status, 'PAUSED');
  assert.equal(seen[1].body.status, 'PAUSED'); assert.equal(seen[1].body.daily_budget, 15000); assert.equal(seen[1].body.campaign_id, 'id1');
  assert.equal(seen[2].body.object_story_spec.link_data.message, 'Garden cottage, R12,500/m.', 'exact approved words');
  assert.equal(seen[2].body.object_story_spec.link_data.link, 'https://example.test/listing');
  assert.equal(seen[3].body.status, 'PAUSED'); assert.equal(seen[3].body.creative.creative_id, 'id3');
  delete process.env.META_AD_ACCOUNT_ID; delete process.env.META_ADS_TOKEN; delete process.env.META_PAGE_ID; delete process.env.HI_META_ADS_API_VERIFIED;
});

test('meta chain failure cleans up created objects and names them (no silent orphans)', async () => {
  process.env.META_AD_ACCOUNT_ID = 'acct-1'; process.env.META_ADS_TOKEN = 'tok'; process.env.META_PAGE_ID = 'page-1'; process.env.HI_META_ADS_API_VERIFIED = '1';
  await propose('propose_ad_campaign', { network: 'meta', headline: 'h', body: 'b', daily_budget_cents: 5000, currency: 'ZAR', link: 'https://example.test/x' });
  const ap = await lastApproval();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ method: opts.method, url: String(url) });
    if (String(url).endsWith('/adsets')) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ id: 'cid1' }) };
  };
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'failed');
  assert.match(d.reason, /cleanup attempted for: cid1/, 'the orphaned campaign is named in the failure');
  assert.ok(calls.some((x) => x.method === 'DELETE' && x.url.endsWith('/cid1')), 'cleanup delete issued for the created campaign');
  const after = (await withTenant(A, (c) => c.query("SELECT payload->'created' AS created FROM approvals WHERE id=$1", [ap.id]))).rows[0];
  assert.equal(after.created.meta_campaign, 'cid1', 'evidence recorded on the approval payload');
  delete process.env.META_AD_ACCOUNT_ID; delete process.env.META_ADS_TOKEN; delete process.env.META_PAGE_ID; delete process.env.HI_META_ADS_API_VERIFIED;
});

test('google chain never trims approved words: over-limit headlines or descriptions fail closed', async () => {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'devtok'; process.env.GOOGLE_ADS_CUSTOMER_ID = '123-456-7890';
  await withTenant(A, (c) => c.query("INSERT INTO integrations (tenant_id, provider, account_email, scopes, access_token_enc, expires_at, status) VALUES (current_setting('app.tenant_id')::uuid,'google','a@example.test','openid email adwords',$1, now() + interval '1 hour','active')", [enc('google-oauth-token')]));
  await propose('propose_ad_campaign', { network: 'google', headline: 'This headline is far too long for a Google ad', headline_2: 'ok', headline_3: 'ok too', body: 'Short description.', description_2: 'Another short one.', daily_budget_cents: 1000, currency: 'ZAR', link: 'https://example.test/l' });
  const ap = await lastApproval();
  let called = 0;
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve', fetchImpl: async () => { called++; return { ok: true, status: 200, json: async () => ({ results: [{ resourceName: 'x' }] }) }; } });
  assert.equal(d.status, 'failed'); assert.match(d.reason, /30-character limit/); assert.match(d.reason, /never trims approved words/);
  assert.equal(called, 0, 'nothing sent when words do not fit');
  await withTenant(A, (c) => c.query("DELETE FROM integrations WHERE provider='google'"));
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN; delete process.env.GOOGLE_ADS_CUSTOMER_ID;
});

test('google chain: needs 3 headlines + 2 descriptions, then budget -> campaign -> ad group -> RSA ad, all PAUSED (stub API)', async () => {
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'devtok'; process.env.GOOGLE_ADS_CUSTOMER_ID = '123-456-7890';
  const owner = await ownerOf(A);
  // Thin draft fails closed instead of inventing words
  await propose('propose_ad_campaign', { network: 'google', headline: 'Kyalami cottage', body: 'b', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/l' });
  const thin = await lastApproval();
  const d0 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: thin.id, decision: 'approve' });
  assert.equal(d0.status, 'failed'); assert.match(d0.reason, /3 headlines and 2 descriptions/);
  // Full draft, but no Google account with ads scope connected
  await propose('propose_ad_campaign', { network: 'google', headline: 'Kyalami cottage to let', headline_2: 'Garden cottage, R12,500', headline_3: 'View this Saturday', body: 'Two-bedroom garden cottage in Kyalami, available 1 December.', description_2: 'Book your viewing today. Water included, prepaid electricity.', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/l' });
  const ap = await lastApproval();
  const d1 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap.id, decision: 'approve' });
  assert.equal(d1.status, 'failed'); assert.match(d1.reason, /ads permission/);
  // Connect the ads-scope account and re-draft (binding requires a fresh draft)
  await withTenant(A, (c) => c.query("INSERT INTO integrations (tenant_id, provider, account_email, scopes, access_token_enc, expires_at, status) VALUES (current_setting('app.tenant_id')::uuid,'google','a@example.test','openid email adwords',$1, now() + interval '1 hour','active')", [enc('google-oauth-token')]));
  await propose('propose_ad_campaign', { network: 'google', headline: 'Kyalami cottage to let', headline_2: 'Garden cottage, R12,500', headline_3: 'View this Saturday', body: 'Two-bedroom garden cottage in Kyalami, available 1 December.', description_2: 'Book your viewing today. Water included, prepaid electricity.', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/l' });
  const ap2 = await lastApproval();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers });
    const rn = 'customers/1234567890/' + String(url).split('/').pop().replace(':mutate', '') + '/9';
    return { ok: true, status: 200, json: async () => ({ results: [{ resourceName: rn }] }) };
  };
  const d2 = await decideApproval({ tenantId: A, userId: owner.id, userEmail: owner.email, approvalId: ap2.id, decision: 'approve', fetchImpl });
  assert.equal(d2.status, 'executed', JSON.stringify(d2));
  assert.deepEqual(seen.map((x) => x.url.split('/').pop()), ['campaignBudgets:mutate', 'campaigns:mutate', 'adGroups:mutate', 'adGroupAds:mutate']);
  assert.ok(seen[0].url.startsWith('https://googleads.googleapis.com/v26/'), 'current API version');
  assert.equal(seen[0].body.operations[0].create.amountMicros, 150000000, 'cents converted to micros exactly');
  assert.equal(seen[0].headers['developer-token'], 'devtok');
  assert.equal(seen[0].headers.authorization, 'Bearer google-oauth-token');
  assert.equal(seen[1].body.operations[0].create.status, 'PAUSED');
  assert.equal(seen[2].body.operations[0].create.status, 'PAUSED');
  const rsa = seen[3].body.operations[0].create.ad.responsiveSearchAd;
  assert.deepEqual(rsa.headlines.map((h) => h.text), ['Kyalami cottage to let', 'Garden cottage, R12,500', 'View this Saturday'], 'exact approved headlines, nothing invented');
  assert.deepEqual(rsa.descriptions.map((d) => d.text), ['Two-bedroom garden cottage in Kyalami, available 1 December.', 'Book your viewing today. Water included, prepaid electricity.']);
  assert.deepEqual(seen[3].body.operations[0].create.ad.finalUrls, ['https://example.test/l']);
  assert.equal(seen[3].body.operations[0].create.status, 'PAUSED');
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN; delete process.env.GOOGLE_ADS_CUSTOMER_ID;
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

test('approvals page shows the full immutable social/ad payload before the click', async () => {
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'a@example.test', password: 'a-long-test-password-1' }) });
  const cookie = (login.headers['set-cookie'] || '').toString().split(';')[0];
  await propose('propose_social_post', { network: 'instagram', text: 'Full caption with every word visible MARKER-CAPTION-9', media_url: 'https://example.test/pic.jpg' });
  process.env.META_AD_ACCOUNT_ID = 'act_998877';
  await propose('propose_ad_campaign', { network: 'meta', headline: 'HEADLINE-MARKER full', headline_2: 'MARKER-H2 second', headline_3: 'MARKER-H3 third', body: 'Body copy every word MARKER-BODY-9', description_2: 'MARKER-DESC2 second description', audience: 'Sandton, 25-45', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/Listing' });
  delete process.env.META_AD_ACCOUNT_ID;
  const page = await app.inject({ url: '/app/approvals', headers: { cookie } });
  assert.ok(page.body.includes('Full caption with every word visible MARKER-CAPTION-9'), 'full caption');
  assert.ok(page.body.includes('https://example.test/pic.jpg'), 'media URL shown');
  assert.ok(page.body.includes('Instagram business account'), 'platform named');
  assert.ok(page.body.includes('HEADLINE-MARKER full') && page.body.includes('MARKER-BODY-9'), 'full headline + body');
  assert.ok(page.body.includes('ZAR 150.00'), 'budget and currency');
  assert.ok(page.body.includes('Sandton, 25-45'), 'audience');
  assert.ok(page.body.includes('https://example.test/Listing'), 'ad link');
  assert.ok(page.body.includes('campaign PAUSED'), 'PAUSED explicit before the click');
  assert.ok(page.body.includes('meta:act_998877'), 'bound ads account shown before the click');
  assert.ok(page.body.includes('MARKER-H2 second') && page.body.includes('MARKER-H3 third'), 'all headlines shown');
  assert.ok(page.body.includes('MARKER-DESC2 second description'), 'second description shown');
  assert.ok(page.body.includes('Audience note'), 'audience labelled as a note, not live targeting');
  assert.ok(page.body.includes('Targeting and keywords are finished in your own ads account'), 'no live-targeting implication');
  assert.ok(page.body.includes('Meta ad creation is not switched on yet'), 'gated Meta execution is honest on the card');
});
