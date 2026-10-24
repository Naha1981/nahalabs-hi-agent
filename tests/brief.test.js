import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant } from '../src/db.js';
import { composeBrief } from '../src/brief.js';

const base = { date: 'Friday, 23 October 2026', events: [], unread: [], matches: [], approvals: 0 };

test('estate section appears only when there are viewings or due follow-ups', () => {
  const plain = composeBrief({ ...base });
  assert.doesNotMatch(plain, /ESTATE TODAY/);
  const withEstate = composeBrief({ ...base, estate: {
    viewings: [{ property: '12 Oak Street, Sandton', contact: 'Sipho Dube', time: '10:00' }],
    followups: [{ next_action: 'bank pre-approval', property: '7 Palm Road', contact: 'New Buyer', date: '2026-10-22' }],
  } });
  assert.match(withEstate, /ESTATE TODAY/);
  assert.match(withEstate, /Viewing 12 Oak Street, Sandton with Sipho Dube at 10:00/);
  assert.match(withEstate, /Due: bank pre-approval - 7 Palm Road \(New Buyer\) \(due 2026-10-22\)/);
});

test('opportunity desk section hidden for tenants without profile keywords', () => {
  const off = composeBrief({ ...base, deskActive: false });
  assert.doesNotMatch(off, /OPPORTUNITY DESK/);
  assert.doesNotMatch(off, /tender/);
  const on = composeBrief({ ...base, matches: [{ title: 'Cleaning services', ocid: 'x', score: 80 }] });
  assert.match(on, /OPPORTUNITY DESK/);
  assert.match(on, /Cleaning services \(fit 80\/100\)/);
});

// DB-level: the brief's estate queries return the right rows and respect RLS.
let db, A, B;
test.before(async () => {
  db = await startDb(54339);
  const o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Alpha') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Beta') RETURNING id")).rows[0].id;
  await o.end();
});
test.after(async () => { await db.stop(); });

test('estate brief queries: due deals and today viewings, tenant-isolated', async () => {
  const seed = (t) => withTenant(t, async (c) => {
    const p = (await c.query("INSERT INTO re_properties (tenant_id, title) VALUES (current_setting('app.tenant_id')::uuid, '12 Oak Street') RETURNING id")).rows[0];
    const k = (await c.query("INSERT INTO re_contacts (tenant_id, name, role) VALUES (current_setting('app.tenant_id')::uuid, 'Sipho Dube', 'buyer') RETURNING id")).rows[0];
    await c.query("INSERT INTO re_deals (tenant_id, property_id, contact_id, stage, next_action, next_action_date) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'offer', 'bank pre-approval', CURRENT_DATE - 1)", [p.id, k.id]);
    await c.query("INSERT INTO re_deals (tenant_id, property_id, contact_id, stage, next_action, next_action_date) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'registered', 'old', CURRENT_DATE - 5)", [p.id, k.id]);
    await c.query("INSERT INTO re_viewings (tenant_id, property_id, contact_id, starts_at) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, CURRENT_DATE + interval '10 hours')", [p.id, k.id]);
  });
  await seed(A); await seed(B);
  const q = (t) => withTenant(t, async (c) => ({
    followups: (await c.query(`SELECT d.next_action, p.title AS property FROM re_deals d JOIN re_properties p ON p.id=d.property_id
      WHERE d.stage NOT IN ('registered','fallen_through') AND d.next_action_date IS NOT NULL AND d.next_action_date <= CURRENT_DATE ORDER BY d.next_action_date LIMIT 5`)).rows,
    viewings: (await c.query(`SELECT p.title AS property FROM re_viewings v JOIN re_properties p ON p.id=v.property_id
      WHERE v.status='scheduled' AND v.starts_at::date = CURRENT_DATE ORDER BY v.starts_at LIMIT 5`)).rows,
  }));
  const ra = await q(A);
  assert.equal(ra.followups.length, 1); // the registered deal is excluded
  assert.equal(ra.followups[0].next_action, 'bank pre-approval');
  assert.equal(ra.viewings.length, 1);
  const rb = await q(B);
  assert.equal(rb.followups.length, 1);
  assert.equal(rb.viewings.length, 1);
});
