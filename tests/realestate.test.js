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

  // A closed deal is a historical outcome, not current interest.
  await call(A, 'estate_add_deal', { property: '12 Oak Street', contact: 'Sipho', stage: 'fallen_through', notes: 'Buyer withdrew' });
  // seller report lands in files
  assert.match(await call(A, 'estate_seller_report', { property: 'Oak Street' }), /Seller report saved as "seller-report-12-oak-street-sandton-/);
  const file = await withTenant(A, (c) => c.query("SELECT content FROM files WHERE filename LIKE 'seller-report-%'").then((r) => r.rows[0]));
  assert.match(file.content, /# Seller report: 12 Oak Street, Sandton/);
  assert.match(file.content, /Stage: OTP signed \| Sipho Dube/);
  assert.match(file.content, /## Current interest and deals/);
  assert.match(file.content, /## Closed outcomes/);
  assert.match(file.content, /Stage: Fallen through \\| Sipho Dube/);
  assert.match(file.content, /Loved the garden/);
});

test('estate validation: bad date, bad stage, ambiguous property', async () => {
  assert.match(await call(A, 'estate_add_deal', { property: '12 Oak Street', next_action_date: 'next Friday' }), /YYYY-MM-DD/);
  assert.match(await call(A, 'estate_update_deal', { property: 'Oak Street', stage: 'closed' }), /Stage must be one of/);
  assert.match(await call(A, 'estate_add_viewing', { property: '12 Oak Street', starts_at: 'tomorrow' }), /ISO date-time/);
  await call(A, 'estate_add_property', { title: 'Oak Cottage' });
  assert.match(await call(A, 'estate_add_deal', { property: 'Oak' }), /Several properties match/);
});


test('estate writes deduplicate contacts by email and identical active deals', async () => {
  assert.match(await call(A, 'estate_add_contact', { name: 'Lerato Mokoena', role: 'buyer', email: 'lerato@example.test', phone: '0821000000' }), /Saved Lerato Mokoena/);
  assert.match(await call(A, 'estate_add_contact', { name: 'Lerato Duplicate', role: 'buyer', email: 'LERATO@example.test' }), /Contact already exists as Lerato Mokoena/);
  const contactCount = await withTenant(A, (c) => c.query("SELECT count(*)::int n FROM re_contacts WHERE lower(email)=lower('lerato@example.test')").then((r) => r.rows[0].n));
  assert.equal(contactCount, 1);

  assert.match(await call(A, 'estate_add_deal', { property: '90 Duplicate Street, Sandton', contact: 'Lerato Mokoena', stage: 'enquiry' }), /Deal started/);
  assert.match(await call(A, 'estate_add_deal', { property: '90 Duplicate Street, Sandton', contact: 'Lerato Mokoena', stage: 'enquiry' }), /Deal already tracked/);
  const dealCount = await withTenant(A, (c) => c.query("SELECT count(*)::int n FROM re_deals d JOIN re_properties p ON p.id=d.property_id WHERE p.title='90 Duplicate Street, Sandton'").then((r) => r.rows[0].n));
  assert.equal(dealCount, 1);
});

test('estate viewing datetimes without offsets are interpreted as SAST', async () => {
  const result = await call(A, 'estate_add_viewing', { property: '77 Time Zone Avenue', starts_at: '2026-11-08T14:00' });
  assert.match(result, /2026-11-08 14:00 SAST/);
  const stored = await withTenant(A, (c) => c.query("SELECT starts_at FROM re_viewings v JOIN re_properties p ON p.id=v.property_id WHERE p.title='77 Time Zone Avenue'").then((r) => r.rows[0].starts_at));
  assert.equal(new Date(stored).toISOString(), '2026-11-08T12:00:00.000Z');
});

test('estate viewing feedback refuses to guess when a property has multiple scheduled viewings', async () => {
  await call(A, 'estate_add_viewing', { property: '88 Ambiguous Viewing Road', starts_at: '2026-12-01T14:00' });
  await call(A, 'estate_add_viewing', { property: '88 Ambiguous Viewing Road', starts_at: '2026-12-02T14:00' });
  const result = await call(A, 'estate_log_viewing', { property: '88 Ambiguous Viewing Road', status: 'done', feedback: 'Great' });
  assert.match(result, /Several scheduled viewings match/);
  const stillScheduled = await withTenant(A, (c) => c.query("SELECT count(*)::int n FROM re_viewings v JOIN re_properties p ON p.id=v.property_id WHERE p.title='88 Ambiguous Viewing Road' AND v.status='scheduled'").then((r) => r.rows[0].n));
  assert.equal(stillScheduled, 2);
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
  await withTenant(A, (c) => c.query("INSERT INTO integrations (tenant_id, provider, account_email) VALUES (current_setting('app.tenant_id')::uuid,'microsoft','agent-outlook@harbourview.test')"));
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
