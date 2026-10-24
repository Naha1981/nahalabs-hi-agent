import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant } from '../src/db.js';
import { runTool } from '../src/tools.js';

let db, A, B, AGENT;
test.before(async () => {
  db = await startDb(54344);
  const o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Dedupe A') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Dedupe B') RETURNING id")).rows[0].id;
  AGENT = (await o.query("INSERT INTO agents (tenant_id, name) VALUES ($1,'hi') RETURNING id", [A])).rows[0].id;
  await o.end();
});
test.after(async () => { await db.stop(); });

const call = (tenantId, name, args) =>
  withTenant(tenantId, (c) => runTool(name, args, { c, tenantId, agentId: AGENT, agentName: 'hi', userEmail: 'a@b.c', sources: [], steps: [], mode: 'chat' }));

test('estate dedupe: find duplicates, merge keeps data, lists hide merged rows', async () => {
  await call(A, 'estate_add_contact', { name: 'John Smit', role: 'buyer', phone: '0821110001' });
  await call(A, 'estate_update_contact', { name: 'John Smit', budget: 1200000, bedrooms_needed: 3, areas: 'Sandton' });
  await call(A, 'estate_add_contact', { name: 'John Smit', role: 'buyer', phone: '0821110002', notes: 'prefers north-facing' });
  await call(A, 'estate_add_contact', { name: 'Alice Dlamini', role: 'buyer', phone: '0821110003' });

  const dupOut = await call(A, 'estate_find_duplicates', {});
  assert.match(dupOut, /John Smit/);
  assert.doesNotMatch(dupOut, /Alice Dlamini/);
  assert.match(dupOut, /after the agent confirms/);

  await call(A, 'estate_add_property', { title: '1 Test St' });
  const upd = await call(A, 'estate_update_property', { title: '1 Test St', price: 1000000, bedrooms: 3, suburb: 'Sandton' });
  assert.doesNotMatch(upd, /No property found/);
  // attach a deal to the duplicate row directly (the deal tool rightly refuses the ambiguous name)
  await withTenant(A, async (c) => {
    const dup = (await c.query("SELECT id FROM re_contacts WHERE phone='0821110002'")).rows[0];
    const prop = (await c.query("SELECT id FROM re_properties WHERE title='1 Test St'")).rows[0];
    await c.query("INSERT INTO re_deals (tenant_id, contact_id, property_id, stage) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,'viewing')", [dup.id, prop.id]);
  });

  const merge = await call(A, 'estate_merge_contacts', { keep: '0821110001', merge: '0821110002' });
  assert.match(merge, /Merged John Smit into John Smit/);
  assert.match(merge, /hidden but kept on record/);

  const counts = await withTenant(A, (c) => c.query("SELECT count(*) FILTER (WHERE merged_into IS NULL)::int active, count(*)::int total FROM re_contacts WHERE name='John Smit'").then((x) => x.rows[0]));
  assert.equal(counts.active, 1);
  assert.equal(counts.total, 2);

  const deals = await call(A, 'estate_list', { what: 'deals' });
  assert.match(deals, /John Smit/);
  const dealRow = await withTenant(A, (c) => c.query("SELECT c.phone FROM re_deals d JOIN re_contacts c ON c.id=d.contact_id").then((x) => x.rows[0]));
  assert.equal(dealRow.phone, '0821110001');

  const notes = await withTenant(A, (c) => c.query("SELECT notes FROM re_contacts WHERE name='John Smit' AND merged_into IS NULL").then((x) => x.rows[0].notes));
  assert.match(notes, /north-facing/);

  const contacts = await call(A, 'estate_list', { what: 'contacts' });
  assert.equal((contacts.match(/John Smit/g) || []).length, 1);

  const dupOut2 = await call(A, 'estate_find_duplicates', {});
  assert.match(dupOut2, /No likely duplicates/);
});

test('estate dedupe: merge guards and tenant isolation', async () => {
  const bCtx = { agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' };
  await withTenant(B, (c) => runTool('estate_add_contact', { name: 'Shared Name', role: 'buyer', phone: '0830000001' }, { ...bCtx, c, tenantId: B }));
  await withTenant(B, (c) => runTool('estate_add_contact', { name: 'Shared Name', role: 'buyer', phone: '0830000002' }, { ...bCtx, c, tenantId: B }));

  // tenant A sees nothing of tenant B's duplicates
  const out = await call(A, 'estate_find_duplicates', {});
  assert.doesNotMatch(out, /Shared Name/);

  // merge against a missing contact fails cleanly
  assert.match(await call(A, 'estate_merge_contacts', { keep: 'John Smit', merge: 'No Such Person' }), /Could not find both/);

  // merging a contact into itself is rejected
  assert.match(await call(A, 'estate_merge_contacts', { keep: 'John Smit', merge: 'John Smit' }), /same contact/);
});

test('estate attention: overdue follow-ups, stalled deals, stale listings surface read-only', async () => {
  // overdue follow-up (next action due in the past)
  await call(A, 'estate_add_property', { title: '7 Attention Ave' });
  await call(A, 'estate_add_contact', { name: 'Oliver Overdue', role: 'buyer', phone: '0850000001' });
  const deal = await call(A, 'estate_add_deal', { property: '7 Attention Ave', contact: 'Oliver Overdue', stage: 'offer', next_action: 'Chase the bank', next_action_date: '2020-01-05' });
  assert.match(deal, /deal/i);

  // stale listing: active > 21 days, no recent viewing
  await call(A, 'estate_add_property', { title: '22 Stale Street' });
  await withTenant(A, (c) => c.query("UPDATE re_properties SET status='active', created_at = now() - interval '45 days' WHERE title='22 Stale Street'"));

  const out = await call(A, 'estate_list', { what: 'attention' });
  assert.match(out, /Needs attention/);
  assert.match(out, /7 Attention Ave \(Oliver Overdue\): "Chase the bank" was due 2020-01-05/);
  assert.match(out, /days overdue/);
  assert.match(out, /22 Stale Street: 45 days on market, no viewing in the last 14 days/);

  // a fresh listing with a recent viewing must not appear
  await call(A, 'estate_add_property', { title: '5 Fresh Road' });
  const out2 = await call(A, 'estate_list', { what: 'attention' });
  assert.doesNotMatch(out2, /5 Fresh Road/);

  // tenant B sees none of tenant A's attention items
  const outB = await withTenant(B, (c) => runTool('estate_list', { what: 'attention' }, { c, tenantId: B, agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' }));
  assert.doesNotMatch(outB, /7 Attention Ave/);
});

test('estate leases: record, list, validate, tenant-isolated', async () => {
  const r = await call(A, 'estate_add_lease', { property: '3 Rental Road', tenant_contact: 'Tandi Tenant', rent: 'R12,500', deposit: 25000, escalation_pct: 6, start_date: '2026-01-01', end_date: '2026-12-31' });
  assert.match(r, /Lease recorded on 3 Rental Road \(new property saved\) - tenant Tandi Tenant \(new contact saved\), rent R12 500\/mo\. Status: active\./);

  const list = await call(A, 'estate_list', { what: 'leases' });
  assert.match(list, /3 Rental Road \| tenant Tandi Tenant \| rent R12 500\/mo \| esc 6(\.00)?% \| ends 2026-12-31 \| active/);

  // the tenant contact gets role tenant
  const role = await withTenant(A, (c) => c.query("SELECT role FROM re_contacts WHERE name='Tandi Tenant'").then((x) => x.rows[0].role));
  assert.equal(role, 'tenant');

  // validation
  assert.match(await call(A, 'estate_add_lease', { property: '3 Rental Road', rent: 'lots' }), /Rent must be a rand amount/);
  assert.match(await call(A, 'estate_add_lease', { property: '3 Rental Road', end_date: '31-12-2026' }), /End date must be YYYY-MM-DD/);
  assert.match(await call(A, 'estate_add_lease', { property: '3 Rental Road', escalation_pct: 250 }), /Escalation must be a percentage/);

  // tenant B sees no leases
  const listB = await withTenant(B, (c) => runTool('estate_list', { what: 'leases' }, { c, tenantId: B, agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' }));
  assert.match(listB, /No leases on record/);
});

test('rent arrears: recorded payments vs due, honest labels, isolation', async () => {
  // the active lease on 3 Rental Road (rent R12,500/mo from 2026-01-01) has no payments yet
  let out = await call(A, 'estate_list', { what: 'attention' });
  assert.match(out, /3 Rental Road \(Tandi Tenant\): recorded rent payments R0 of R125 000 due since 2026-01-01 - R125 000 short, assuming monthly rent from the lease start/);

  const rec = await call(A, 'estate_record_payment', { property: '3 Rental Road', amount: 'R12,500', period: '2026-01' });
  assert.match(rec, /Recorded R12 500 on 3 Rental Road \(Tandi Tenant\) for 2026-01/);
  assert.match(rec, /HI only knows payments you record/);

  out = await call(A, 'estate_list', { what: 'attention' });
  assert.match(out, /recorded rent payments R12 500 of R125 000 due since 2026-01-01 - R112 500 short, assuming monthly rent from the lease start/);

  const pays = await call(A, 'estate_list', { what: 'payments' });
  assert.match(pays, /3 Rental Road \| Tandi Tenant \| R12 500 \| 2026-01/);

  // validation + unknown lease
  assert.match(await call(A, 'estate_record_payment', { property: '3 Rental Road', amount: 'lots' }), /rand amount/);
  assert.match(await call(A, 'estate_record_payment', { property: 'Nowhere Place', amount: 100 }), /No active lease found/);

  // tenant B: no payments, no arrears lines about A
  const ctxB = { agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' };
  assert.match(await withTenant(B, (c) => runTool('estate_list', { what: 'payments' }, { ...ctxB, c, tenantId: B })), /No rent payments recorded/);
  const attnB = await withTenant(B, (c) => runTool('estate_list', { what: 'attention' }, { ...ctxB, c, tenantId: B }));
  assert.doesNotMatch(attnB, /3 Rental Road/);
});

test('maintenance: log, list, update, stale surfaces in attention, isolation', async () => {
  const add = await call(A, 'estate_add_maintenance', { property: '3 Rental Road', title: 'Geyser leaking', detail: 'Water in the ceiling', priority: 'urgent', contact: 'Tandi Tenant' });
  assert.match(add, /Maintenance logged on 3 Rental Road: Geyser leaking \(reported by Tandi Tenant\) - urgent/);

  const list = await call(A, 'estate_list', { what: 'maintenance' });
  assert.match(list, /3 Rental Road \| Geyser leaking \| open \(urgent\) \| by Tandi Tenant/);

  // fresh requests are not attention items; backdate past 14 days and it surfaces
  let attn = await call(A, 'estate_list', { what: 'attention' });
  assert.doesNotMatch(attn, /Geyser leaking/);
  await withTenant(A, (c) => c.query("UPDATE re_maintenance SET reported_on = current_date - 20 WHERE title='Geyser leaking'"));
  attn = await call(A, 'estate_list', { what: 'attention' });
  assert.match(attn, /3 Rental Road: maintenance "Geyser leaking" open 20 days \(urgent\)/);

  const upd = await call(A, 'estate_update_maintenance', { property: '3 Rental Road', title: 'Geyser', status: 'done', notes: 'plumber replaced element' });
  assert.match(upd, /Maintenance "Geyser leaking" at 3 Rental Road is now done/);
  attn = await call(A, 'estate_list', { what: 'attention' });
  assert.doesNotMatch(attn, /Geyser leaking/);

  // guards
  assert.match(await call(A, 'estate_update_maintenance', { property: '3 Rental Road', status: 'maybe' }), /Status must be/);
  assert.match(await call(A, 'estate_update_maintenance', { property: '3 Rental Road', title: 'Geyser', status: 'open' }), /No open maintenance request matched/);

  // tenant B sees nothing of A's requests
  const ctxB = { agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' };
  assert.match(await withTenant(B, (c) => runTool('estate_list', { what: 'maintenance' }, { ...ctxB, c, tenantId: B })), /No maintenance requests on record/);
});

test('expenses: record, list with month total, validation, isolation', async () => {
  const r = await call(A, 'estate_add_expense', { amount: 'R850', category: 'marketing', vendor: 'Local Printers', property: '3 Rental Road', spent_on: '2026-10-20' });
  assert.match(r, /Expense recorded: marketing R850 at Local Printers for 3 Rental Road/);
  assert.match(r, /HI does not calculate tax or claims/);

  const km = await call(A, 'estate_add_expense', { mileage_km: 42.5, category: 'travel', notes: 'show house round trip' });
  assert.match(km, /Expense recorded: travel 42.5 km/);

  const list = await call(A, 'estate_list', { what: 'expenses' });
  assert.match(list, /2026-10-20 \| marketing \| R850 \| Local Printers \| 3 Rental Road/);
  assert.match(list, /travel \| 42.5 km/);
  assert.match(list, /Recorded this month: R850/);

  assert.match(await call(A, 'estate_add_expense', {}), /Give an amount, kilometres, or both/);
  assert.match(await call(A, 'estate_add_expense', { amount: 'lots' }), /rand amount/);
  assert.match(await call(A, 'estate_add_expense', { mileage_km: 9999 }), /kilometres/);
  assert.match(await call(A, 'estate_add_expense', { amount: 100, property: 'Nowhere' }), /No property found/);

  const ctxB = { agentId: AGENT, agentName: 'hi', userEmail: 'b@b.c', sources: [], steps: [], mode: 'chat' };
  assert.match(await withTenant(B, (c) => runTool('estate_list', { what: 'expenses' }, { ...ctxB, c, tenantId: B })), /No expenses recorded/);
});
