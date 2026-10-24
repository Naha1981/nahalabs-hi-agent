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
