import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant } from '../src/db.js';
import { runTool } from '../src/tools.js';

let db, A, B, AGENT;
test.before(async () => {
  db = await startDb(54329);
  const o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Alpha') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Beta') RETURNING id")).rows[0].id;
  AGENT = (await o.query("INSERT INTO agents (tenant_id, name) VALUES ($1,'hi') RETURNING id", [A])).rows[0].id;
  await o.end();
});
test.after(async () => { await db.stop(); });

const call = (tenantId, name, args) =>
  withTenant(tenantId, (c) => runTool(name, args, { c, tenantId, agentId: AGENT, agentName: 'hi', userEmail: 'a@b.c', sources: [], steps: [], mode: 'chat' }));

test('estate flow: contact, property, deal, update, viewing, report', async () => {
  assert.match(await call(A, 'estate_add_contact', { name: 'Sipho Dube', role: 'buyer', phone: '0821112222' }), /Saved Sipho Dube as a buyer/);
  assert.match(await call(A, 'estate_add_property', { title: '12 Oak Street, Sandton', asking_price: 'R2.4m' }), /Saved property/);

  const r1 = await call(A, 'estate_add_deal', { property: '12 Oak Street', contact: 'Sipho', stage: 'offer', next_action: 'bank pre-approval', next_action_date: '2020-01-01' });
  assert.match(r1, /Deal started on 12 Oak Street, Sandton with Sipho Dube\. Stage: Offer\./);

  // auto-creates unknown property and contact
  const r2 = await call(A, 'estate_add_deal', { property: '7 Palm Road', contact: 'New Buyer', notes: 'from portal enquiry' });
  assert.match(r2, /new property saved/);
  assert.match(r2, /new contact saved/);
  assert.match(r2, /Stage: Enquiry/);

  // pipeline and due
  const pipe = await call(A, 'estate_list', { what: 'pipeline' });
  assert.match(pipe, /Offer:\n- 12 Oak Street, Sandton \| Sipho Dube \| next: bank pre-approval/);
  assert.match(pipe, /Enquiry:\n- 7 Palm Road \| New Buyer/);
  const due = await call(A, 'estate_list', { what: 'due' });
  assert.match(due, /2020-01-01 \| 12 Oak Street, Sandton \| Sipho Dube \| bank pre-approval/);

  // update by property name: stage + note
  const up = await call(A, 'estate_update_deal', { property: 'Oak Street', stage: 'otp_signed', note: 'OTP signed at office' });
  assert.match(up, /now at OTP signed/);
  const notes = await withTenant(A, (c) => c.query('SELECT d.stage, d.notes FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title ILIKE $1', ['%Oak%']).then((r) => r.rows[0]));
  assert.equal(notes.stage, 'otp_signed');
  assert.match(notes.notes, /OTP signed at office/);

  // viewing + log
  assert.match(await call(A, 'estate_add_viewing', { property: '12 Oak Street', contact: 'Sipho', starts_at: '2026-10-24T14:00' }), /Viewing of 12 Oak Street, Sandton booked/);
  assert.match(await call(A, 'estate_log_viewing', { property: 'Oak Street', status: 'done', feedback: 'Loved the garden, worried about levy' }), /marked done/);
  const views = await call(A, 'estate_list', { what: 'viewings' });
  assert.match(views, /No upcoming viewings/);

  // seller report lands in files
  assert.match(await call(A, 'estate_seller_report', { property: 'Oak Street' }), /Seller report saved as "seller-report-12-oak-street-sandton-/);
  const file = await withTenant(A, (c) => c.query("SELECT content FROM files WHERE filename LIKE 'seller-report-%'").then((r) => r.rows[0]));
  assert.match(file.content, /# Seller report: 12 Oak Street, Sandton/);
  assert.match(file.content, /Stage: OTP signed \| Sipho Dube/);
  assert.match(file.content, /Loved the garden/);
});

test('estate validation: bad date, bad stage, ambiguous property', async () => {
  assert.match(await call(A, 'estate_add_deal', { property: '12 Oak Street', next_action_date: 'next Friday' }), /YYYY-MM-DD/);
  assert.match(await call(A, 'estate_update_deal', { property: 'Oak Street', stage: 'closed' }), /Stage must be one of/);
  assert.match(await call(A, 'estate_add_viewing', { property: '12 Oak Street', starts_at: 'tomorrow' }), /ISO date-time/);
  await call(A, 'estate_add_property', { title: 'Oak Cottage' });
  assert.match(await call(A, 'estate_add_deal', { property: 'Oak' }), /Several properties match/);
});

test('ACCEPTANCE tenant isolation: tenant B cannot see or touch tenant A real-estate data', async () => {
  assert.equal(await call(B, 'estate_list', { what: 'pipeline' }), 'No deals yet. Add one with estate_add_deal.');
  assert.equal(await call(B, 'estate_list', { what: 'contacts' }), 'No contacts yet.');
  assert.match(await call(B, 'estate_seller_report', { property: 'Oak Street' }), /No property matches/);
  const dealId = await withTenant(A, (c) => c.query("SELECT d.id FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title ILIKE '%Oak Street%' LIMIT 1").then((r) => r.rows[0].id));
  assert.match(await call(B, 'estate_update_deal', { deal_id: dealId, stage: 'fallen_through' }), /No matching deal found/);
  const still = await withTenant(A, (c) => c.query('SELECT stage FROM re_deals WHERE id=$1', [dealId]).then((r) => r.rows[0].stage));
  assert.equal(still, 'otp_signed');
});

test('estate tools never invent dates: missing fields stay empty', async () => {
  assert.match(await call(A, 'estate_add_deal', { property: '9 Vine Close', stage: 'otp_signed' }), /Deal started/);
  const row = await withTenant(A, (c) => c.query("SELECT d.next_action, d.next_action_date FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title='9 Vine Close'").then((r) => r.rows[0]));
  assert.equal(row.next_action, '');
  assert.equal(row.next_action_date, null);
});

test('estate enquiry watch: needs an inbox, enables once, disables', async () => {
  // Tenant B has no connected inbox
  assert.match(await call(B, 'estate_enquiry_watch', { action: 'enable' }), /Connect Gmail or Outlook/);
  // Give tenant A a connected google integration
  await withTenant(A, (c) => c.query("INSERT INTO integrations (tenant_id, provider, account_email) VALUES (current_setting('app.tenant_id')::uuid,'google','agent@harbourview.test')"));
  assert.match(await call(A, 'estate_enquiry_watch', { action: 'enable', every_minutes: 180 }), /Enquiry watch on\. Every 180 minutes/);
  const task = await withTenant(A, (c) => c.query("SELECT title, interval_minutes, status, instruction FROM tasks WHERE title='Enquiry watch'").then((r) => r.rows[0]));
  assert.equal(task.interval_minutes, 180);
  assert.equal(task.status, 'active');
  assert.match(task.instruction, /never invent price, levies, rates or availability/);
  assert.match(task.instruction, /never create duplicates/);
  assert.match(await call(A, 'estate_enquiry_watch', { action: 'enable' }), /already on/);
  assert.match(await call(A, 'estate_enquiry_watch', { action: 'disable' }), /Enquiry watch off/);
  assert.equal(await withTenant(A, (c) => c.query("SELECT status FROM tasks WHERE title='Enquiry watch'").then((r) => r.rows[0].status)), 'paused');
  assert.match(await call(A, 'estate_enquiry_watch', { action: 'disable' }), /not on/);
});

test('enquiry watch is inert for existing tenants: no task, nothing runs', async () => {
  // Fresh tenant C, as an existing tenant after deploy: zero estate-related rows, zero tasks.
  const o = owner(db.ownerUrl); await o.connect();
  const C = (await o.query("INSERT INTO tenants (name) VALUES ('Gamma') RETURNING id")).rows[0].id;
  await o.end();
  const counts = await withTenant(C, async (c) => ({
    tasks: (await c.query('SELECT count(*)::int n FROM tasks')).rows[0].n,
    contacts: (await c.query('SELECT count(*)::int n FROM re_contacts')).rows[0].n,
    deals: (await c.query('SELECT count(*)::int n FROM re_deals')).rows[0].n,
    approvals: (await c.query('SELECT count(*)::int n FROM approvals')).rows[0].n,
  }));
  assert.deepEqual(counts, { tasks: 0, contacts: 0, deals: 0, approvals: 0 });
  // The scheduler finds nothing to run for C.
  const { runDueTasks } = await import('../src/agent.js');
  const ran = await runDueTasks({ llm: async () => ({ content: 'x', tool_calls: [] }), fetchImpl: async () => { throw new Error('no network'); }, lookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(ran.filter((x) => String(x.tenant) === C).length, 0);
  // And in unattended mode the watch cannot be switched on or modified.
  assert.match(await withTenant(C, (c) => runTool('estate_enquiry_watch', { action: 'enable' }, { c, tenantId: C, agentId: AGENT, agentName: 'hi', userEmail: 'c@d.e', sources: [], steps: [], mode: 'task' })), /cannot change the enquiry watch/);
});

test('estate deal commission: price + pct stored in cents, recomputed, validated', async () => {
  await call(A, 'estate_add_deal', { property: '5 Protea Lane, Midrand', contact: 'Johan Venter', stage: 'viewing' });
  const bad = await call(A, 'estate_update_deal', { property: '5 Protea Lane', sale_price: 'abc' });
  assert.match(bad, /rand amount/);
  const badPct = await call(A, 'estate_update_deal', { property: '5 Protea Lane', commission_pct: 140 });
  assert.match(badPct, /between 0 and 100/);
  const r = await call(A, 'estate_update_deal', { property: '5 Protea Lane', stage: 'offer', sale_price: 'R1,250,000', commission_pct: 5 });
  assert.match(r, /Commission: R62 500 \(5% of R1 250 000\)/);
  const row = await withTenant(A, (c) => c.query("SELECT d.sale_price_cents, d.commission_pct, d.commission_cents FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title ILIKE '%Protea%'").then((x) => x.rows[0]));
  assert.equal(String(row.sale_price_cents), '125000000');
  assert.equal(String(row.commission_cents), '6250000');
  // changing only the pct recomputes from the stored price
  await call(A, 'estate_update_deal', { property: '5 Protea Lane', commission_pct: 6 });
  const again = await withTenant(A, (c) => c.query("SELECT d.commission_cents FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title ILIKE '%Protea%'").then((x) => x.rows[0]));
  assert.equal(String(again.commission_cents), '7500000');
});

test('enquiry source: stored, validated, listed, tenant-isolated', async () => {
  const r = await call(A, 'estate_add_contact', { name: 'Lerato K', role: 'buyer', email: 'lerato@example.test', source: 'portal' });
  assert.match(r, /Saved Lerato K as a buyer \(source: portal\)/);
  const list = await call(A, 'estate_list', { what: 'contacts' });
  assert.match(list, /Lerato K \(buyer\) \| lerato@example\.test \| via portal/);
  const bad = await call(A, 'estate_add_contact', { name: 'No Source', source: 'mars' });
  assert.match(bad, /Saved No Source/); // invalid source falls back to empty, never errors
  const row = await withTenant(A, (c) => c.query("SELECT source FROM re_contacts WHERE name='No Source'").then((x) => x.rows[0]));
  assert.equal(row.source, '');
  const listB = await call(B, 'estate_list', { what: 'contacts' });
  assert.equal(listB, 'No contacts yet.');
});

test('contact FICA status: set on add, updated, listed, validated', async () => {
  const r = await call(A, 'estate_add_contact', { name: 'FICA Fred', role: 'buyer', fica_status: 'requested' });
  assert.match(r, /Saved FICA Fred as a buyer, FICA requested/);
  const up = await call(A, 'estate_update_contact', { name: 'FICA Fred', fica_status: 'verified' });
  assert.match(up, /FICA Fred updated - FICA verified/);
  const list = await call(A, 'estate_list', { what: 'contacts' });
  assert.match(list, /FICA Fred \(buyer\).*FICA verified/);
  const bad = await call(A, 'estate_update_contact', { name: 'FICA Fred', fica_status: 'maybe' });
  assert.match(bad, /requested, received or verified/);
  const missing = await call(A, 'estate_update_contact', { name: 'No Such Person', fica_status: 'verified' });
  assert.match(missing, /No contact found/);
  const row = await withTenant(A, (c) => c.query("SELECT fica_status FROM re_contacts WHERE name='FICA Fred'").then((x) => x.rows[0]));
  assert.equal(row.fica_status, 'verified');
});

test('structured matching: buyers for a property, listings for a buyer, price tracking', async () => {
  await call(A, 'estate_add_property', { title: '8 Jacaranda Ave, Sandton', price: 'R1,500,000', bedrooms: 3, suburb: 'Sandton' });
  await call(A, 'estate_add_property', { title: '22 Palm Heights, Midrand', price: 'R950,000', bedrooms: 2, suburb: 'Midrand' });
  await call(A, 'estate_add_property', { title: '1 Fig Lane, Cape Town', price: 'R3,200,000', bedrooms: 4, suburb: 'Cape Town' });
  await call(A, 'estate_add_contact', { name: 'Buyer One', role: 'buyer' });
  await call(A, 'estate_update_contact', { name: 'Buyer One', budget: 'R1.8m', bedrooms_needed: 3, areas: 'Sandton, Bryanston' });
  await call(A, 'estate_add_contact', { name: 'Buyer Two', role: 'buyer' });
  await call(A, 'estate_update_contact', { name: 'Buyer Two', budget: 'R1,000,000' });

  const forProp = await call(A, 'estate_match', { property: '8 Jacaranda' });
  assert.match(forProp, /Buyer One/);               // budget 1.8m covers 1.5m, 3 bed met, Sandton fits
  assert.doesNotMatch(forProp, /Buyer Two/);        // budget 1.0m too low

  const forBuyer = await call(A, 'estate_match', { contact: 'Buyer One' });
  assert.match(forBuyer, /8 Jacaranda Ave/);        // fits budget + beds + area
  assert.doesNotMatch(forBuyer, /22 Palm Heights/); // only 2 bed
  assert.doesNotMatch(forBuyer, /1 Fig Lane/);      // over budget and wrong area

  const two = await call(A, 'estate_match', { contact: 'Buyer Two' });
  assert.match(two, /22 Palm Heights/);
  assert.doesNotMatch(two, /8 Jacaranda/);

  // price update tracks the change date and refreshes display price
  const up = await call(A, 'estate_update_property', { title: '8 Jacaranda', price: 'R1,400,000' });
  assert.match(up, /updated/);
  const row = await withTenant(A, (c) => c.query("SELECT price_cents, asking_price, price_updated_at FROM re_properties WHERE title ILIKE '%Jacaranda%'").then((x) => x.rows[0]));
  assert.equal(String(row.price_cents), '140000000');
  assert.equal(row.asking_price, 'R1 400 000');
  assert.ok(row.price_updated_at);
  // validation
  assert.match(await call(A, 'estate_update_property', { title: '8 Jacaranda', price: 'free' }), /rand amount/);
  assert.match(await call(A, 'estate_update_contact', { name: 'Buyer One', budget: 'lots' }), /rand amount/);
  // RLS: Beta sees none of Alpha's records through match
  assert.match(await call(B, 'estate_match', { property: '8 Jacaranda' }), /No property found/);
});
