import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { runTool } from '../src/tools.js';
import { estateAttention } from '../src/attention.js';

// Structured qualification, marketing spend per enquiry channel, and the Estate page
// cards for leases / maintenance / money records. Local HTTP + tool level, no LLM.

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.PUBLIC_BASE_URL = 'https://hi.example.test';
delete process.env.GROQ_API_KEY;
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
const lookup = async () => [{ address: '93.184.216.34' }];

let db, app, A, B;
test.before(async () => {
  db = await startDb(54353);
  app = await buildApp({ lookup });
  const mk = async (company, email) => {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const cookie = (login.headers['set-cookie'] || '').split(';')[0];
    const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
    const agent = await ensureDefaultAgent(tenantId);
    return { company, email, cookie, tenantId, agentId: agent.id };
  };
  A = await mk('Qualify Estates', 'alpha@qualify.test');
  B = await mk('Other Realty', 'beta@qualify.test');
});
test.after(async () => { await app.close(); await db.stop(); });

const call = (t, name, args) => withTenant(t.tenantId, (c) => runTool(name, args, { c, tenantId: t.tenantId, agentId: t.agentId, agentName: 'hi', userEmail: t.email, sources: [], steps: [], mode: 'chat' }));

test('qualification: fields set, validated, listed, and surfaced as attention', async () => {
  assert.match(await call(A, 'estate_add_contact', { name: 'Naledi K', role: 'buyer', phone: '0823334444' }), /Saved Naledi K as a buyer/);

  // unqualified buyer surfaces once as a summary attention line
  let attn = await withTenant(A.tenantId, (c) => estateAttention(c));
  assert.ok(attn.some((x) => x.kind === 'qualification_gap' && /1 buyer\/tenant contact/.test(x.text)), 'qualification gap attention missing');

  // invalid values rejected, contact untouched
  assert.match(await call(A, 'estate_update_contact', { name: 'Naledi', qualification_status: 'hot' }), /Qualification status must be/);
  assert.match(await call(A, 'estate_update_contact', { name: 'Naledi', bond_status: 'yes' }), /Bond status must be/);
  assert.match(await call(A, 'estate_update_contact', { name: 'Naledi', timeframe: 'soon' }), /Timeframe must be/);

  assert.match(await call(A, 'estate_update_contact', { name: 'Naledi', qualification_status: 'qualified', bond_status: 'preapproved', timeframe: '0-3 months' }), /Naledi K updated./);
  const row = await withTenant(A.tenantId, (c) => c.query("SELECT qualification_status, bond_status, timeframe FROM re_contacts WHERE name='Naledi K'").then((r) => r.rows[0]));
  assert.deepEqual(row, { qualification_status: 'qualified', bond_status: 'preapproved', timeframe: '0-3 months' });

  const list = await call(A, 'estate_list', { what: 'contacts' });
  assert.match(list, /Naledi K \(buyer\).*qualified \| bond preapproved \| 0-3 months/);

  attn = await withTenant(A.tenantId, (c) => estateAttention(c));
  assert.ok(!attn.some((x) => x.kind === 'qualification_gap'), 'qualified contact should clear the gap line');

  // tenant B never sees A's qualification data
  const bList = await call(B, 'estate_list', { what: 'contacts' });
  assert.equal(bList, 'No contacts yet.');
  const bAttn = await withTenant(B.tenantId, (c) => estateAttention(c));
  assert.ok(!bAttn.some((x) => x.kind === 'qualification_gap'));
});

test('spend: channel capture, cost per enquiry with honest wording, validation', async () => {
  // invalid channel rejected
  assert.match(await call(A, 'estate_add_expense', { amount: 'R100', category: 'marketing', channel: 'tiktok' }), /Channel must be portal, website, referral, signboard, walk_in or other/);
  // channel-less spend still allowed, just not attributed
  assert.match(await call(A, 'estate_add_expense', { amount: 'R300', category: 'marketing', vendor: 'Printer' }), /Expense recorded: marketing R300/);
  assert.match(await call(A, 'estate_add_expense', { amount: 'R1200', category: 'marketing', channel: 'portal', vendor: 'Portal subs' }), /Expense recorded: marketing R1 200/);
  assert.match(await call(A, 'estate_add_expense', { amount: 'R800', category: 'marketing', channel: 'portal', vendor: 'Portal boost' }), /Expense recorded: marketing R800/);

  await call(A, 'estate_add_contact', { name: 'Buyer One', role: 'buyer', source: 'portal' });
  await call(A, 'estate_add_contact', { name: 'Buyer Two', role: 'buyer', source: 'website' });

  const spend = await call(A, 'estate_list', { what: 'spend' });
  assert.match(spend, /- portal: 1 enquiry \| recorded spend R2 000 \| cost per enquiry R2 000/);
  assert.match(spend, /- website: 1 enquiry \| recorded spend R0/);
  assert.match(spend, /not ROI: HI has no revenue attribution/);
  // channel-less R300 is not attributed to any channel
  assert.ok(!/R2 300/.test(spend));

  // tenant B sees none of A's spend or sources
  const bSpend = await call(B, 'estate_list', { what: 'spend' });
  assert.match(bSpend, /No spend or enquiry sources recorded yet/);
});

test('estate page: lease, maintenance and money cards render own data only', async () => {
  assert.match(await call(A, 'estate_add_lease', { property: '5 River View, Midrand', tenant_contact: 'Lindi M', rent: 'R12,500', start_date: '2026-04-01', end_date: '2027-03-31' }), /Lease recorded on 5 River View, Midrand/);
  assert.match(await call(A, 'estate_record_payment', { property: 'River View', amount: 'R12,500', paid_on: '2026-10-05', period: '2026-10' }), /Recorded R12 500/);
  assert.match(await call(A, 'estate_add_maintenance', { property: 'River View', title: 'Geyser leaking', priority: 'urgent', contact: 'Lindi M' }), /Maintenance logged on 5 River View, Midrand: Geyser leaking/);
  assert.match(await call(A, 'estate_add_invoice', { invoice_no: 'INV-101', amount: 'R8,550', contact: 'Lindi M', due_on: '2026-11-01' }), /Invoice recorded: INV-101 R8 550/);
  assert.match(await call(A, 'estate_add_expense', { amount: 'R850', category: 'office', vendor: 'Stationers' }), /Expense recorded: office R850/);

  const r = await app.inject({ url: '/app/estate', headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Active leases/);
  assert.match(r.body, /5 River View, Midrand/);
  assert.match(r.body, /Lindi M/);
  assert.match(r.body, /R12 500 \/ month/);
  assert.match(r.body, /2027-03-31/);
  assert.match(r.body, /Open maintenance/);
  assert.match(r.body, /Geyser leaking/);
  assert.match(r.body, /Money records/);
  assert.match(r.body, /Expenses this month: <b>R3 150<\/b> across 4 entries/);
  assert.match(r.body, /Recent payments/);
  assert.match(r.body, /R12 500 \(2026-10\)/);
  assert.match(r.body, /Unpaid invoices/);
  assert.match(r.body, /INV-101/);
  assert.match(r.body, /Cost per enquiry/);
  assert.match(r.body, /not ROI, HI does not track revenue attribution/);
  assert.ok(!/Nothing tracked yet/.test(r.body));

  // tenant B's page shows none of A's records
  const rb = await app.inject({ url: '/app/estate', headers: { cookie: B.cookie } });
  assert.equal(rb.statusCode, 200);
  assert.ok(!/River View/.test(rb.body));
  assert.ok(!/Geyser/.test(rb.body));
  assert.ok(!/INV-101/.test(rb.body));
});
