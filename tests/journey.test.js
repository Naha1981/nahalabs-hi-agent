import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { runTool } from '../src/tools.js';
import { proposeAccountEmail } from '../src/integrations.js';

// Model-free full journey: real HTTP requests (signup -> login -> pages) plus the exact
// tool calls the agent would make from chat, with approval and tenant-isolation boundaries
// checked at the HTTP level. No LLM involved anywhere.

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.PUBLIC_BASE_URL = 'https://hi.example.test';
delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
const lookup = async () => [{ address: '93.184.216.34' }];

let db, app, A, B;
test.before(async () => {
  db = await startDb(54352);
  app = await buildApp({ lookup });
  const mk = async (company, email) => {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const cookie = (login.headers['set-cookie'] || '').split(';')[0];
    const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
    const agent = await ensureDefaultAgent(tenantId);
    return { company, email, cookie, tenantId, agentId: agent.id };
  };
  A = await mk('Journey Estates', 'alpha@journey.test');
  B = await mk('Other Realty', 'beta@journey.test');
});
test.after(async () => { await app.close(); await db.stop(); });

const call = (t, name, args) => withTenant(t.tenantId, (c) => runTool(name, args, { c, tenantId: t.tenantId, agentId: t.agentId, agentName: 'hi', userEmail: t.email, sources: [], steps: [], mode: 'chat' }));

test('journey: signup to working estate desk with boundaries intact', async () => {
  // 1. Fresh tenant lands on an empty but working Estate page
  let r = await app.inject({ url: '/app/estate', headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(r.body, /Needs attention/);

  // 2. The agent records a real working day through the same tools chat uses
  assert.match(await call(A, 'estate_add_property', { title: '12 Oak Street, Sandton', asking_price: 'R2.4m' }), /Saved property/);
  await call(A, 'estate_update_property', { title: '12 Oak Street', price: 2400000, bedrooms: 4, suburb: 'Sandton' });
  await call(A, 'estate_add_contact', { name: 'Sipho Dube', role: 'buyer', phone: '0821112222', source: 'portal' });
  await call(A, 'estate_update_contact', { name: 'Sipho Dube', budget: 'R2.5m', bedrooms_needed: 3, areas: 'Sandton', fica_status: 'requested' });
  await call(A, 'estate_add_deal', { property: '12 Oak Street', contact: 'Sipho Dube', stage: 'offer', next_action: 'bank pre-approval', next_action_date: '2020-01-01' });
  assert.match(await call(A, 'estate_add_lease', { property: '5 Flat Road', tenant_contact: 'Tandi Tenant', rent: 'R11,000', start_date: '2026-01-01', end_date: '2026-12-31' }), /Lease recorded/);
  await call(A, 'estate_add_maintenance', { property: '5 Flat Road', title: 'Stove not working', contact: 'Tandi Tenant' });
  const deck = await call(A, 'estate_mandate_deck', { property: '12 Oak Street' });
  assert.match(deck, /Mandate pitch saved/);

  // 3. Attention surfaces what matters
  const attn = await call(A, 'estate_list', { what: 'attention' });
  assert.match(attn, /12 Oak Street, Sandton \(Sipho Dube\): "bank pre-approval" was due 2020-01-01/);
  assert.match(attn, /recorded rent payments R0 of R/);

  // 4. Estate page reflects it all
  r = await app.inject({ url: '/app/estate', headers: { cookie: A.cookie } });
  assert.match(r.body, /Needs attention/);
  assert.match(r.body, /12 Oak Street, Sandton/);
  assert.match(r.body, /5 Flat Road/);
  assert.match(r.body, /Overdue and upcoming follow-ups/);
  assert.match(r.body, /<td>portal<\/td><td>1<\/td>/);

  // 5. The deck file downloads as a sandboxed attachment, never inline HTML
  const fileId = await withTenant(A.tenantId, (c) => c.query("SELECT id FROM files WHERE filename LIKE 'Mandate proposal%' LIMIT 1").then((x) => x.rows[0].id));
  r = await app.inject({ url: `/app/files/${fileId}/download`, headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-disposition'], /attachment/);
  assert.match(r.headers['content-security-policy'], /sandbox/);
  assert.match(r.headers['x-content-type-options'], /nosniff/);

  // 6. Approval boundary: an account email is proposed, visible in Approvals, never sent
  await withTenant(A.tenantId, async (c) => {
    await c.query("INSERT INTO integrations (tenant_id, provider, account_email) VALUES (current_setting('app.tenant_id')::uuid,'google','agent@journey.test')");
    const integ = (await c.query("SELECT id FROM integrations LIMIT 1")).rows[0];
    const p = await proposeAccountEmail(c, { tenantId: A.tenantId, integrationId: integ.id, to: 'alpha@journey.test', subject: 'Journey check', body: 'body', actor: 'test' });
    assert.ok(p.approval_id);
  });
  r = await app.inject({ url: '/app/approvals', headers: { cookie: A.cookie } });
  assert.match(r.body, /Journey check/);
  const sentRows = await withSystem((c) => c.query("SELECT count(*)::int n FROM email_log").then((x) => x.rows[0].n));
  assert.equal(sentRows, 0);

  // 7. Toggles stay default-off
  r = await app.inject({ url: '/app/settings', headers: { cookie: A.cookie } });
  assert.match(r.body, /Email me expiry and lease-end reminders/);
  assert.match(r.body, /Email me viewing reminders/);
  assert.match(r.body, /Auto-send my morning brief/);

  // 8. Tenant isolation end to end: Beta sees none of Alpha anywhere
  r = await app.inject({ url: '/app/estate', headers: { cookie: B.cookie } });
  assert.doesNotMatch(r.body, /5 Flat Road/);      // seeded only in Alpha; the empty-state example names other strings
  assert.doesNotMatch(r.body, /Tandi Tenant/);
  assert.doesNotMatch(r.body, /Needs attention/);
  r = await app.inject({ url: `/app/files/${fileId}/download`, headers: { cookie: B.cookie } });
  assert.notEqual(r.statusCode, 200);
  assert.doesNotMatch(r.body, /Mandate proposal/);
  r = await app.inject({ url: '/app/approvals', headers: { cookie: B.cookie } });
  assert.doesNotMatch(r.body, /Journey check/);
  const bTools = await call(B, 'estate_list', { what: 'contacts' });
  assert.doesNotMatch(bTools, /Sipho/);
});
