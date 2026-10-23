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
