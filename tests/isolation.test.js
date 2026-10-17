import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant, withSystem, audit } from '../src/db.js';

let db, A, B;
test.before(async () => {
  db = await startDb(54321);
  const o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Alpha') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Beta') RETURNING id")).rows[0].id;
  await o.end();
  for (const [t, name] of [[A, 'Alpha'], [B, 'Beta']]) {
    await withTenant(t, async (c) => {
      await c.query("INSERT INTO profiles (tenant_id, company_name, keywords) VALUES (current_setting('app.tenant_id')::uuid,$1,'{cleaning}')", [name]);
      await c.query("INSERT INTO vault_docs (tenant_id, doc_type, title) VALUES (current_setting('app.tenant_id')::uuid,'Other',$1)", [name + ' doc']);
      await c.query("INSERT INTO memory_notes (tenant_id, kind, subject) VALUES (current_setting('app.tenant_id')::uuid,'preference',$1)", [name + ' note']);
      await c.query("INSERT INTO briefs (tenant_id, subject, body_text) VALUES (current_setting('app.tenant_id')::uuid,$1,'x')", [name + ' brief']);
      await c.query("INSERT INTO approvals (tenant_id, kind, summary, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'send_brief',$1,'agent:test')", [name + ' approval']);
      await audit(c, t, 'test', 'seed', {});
    });
  }
});
test.after(async () => { await db.stop(); });

const TABLES = ['profiles', 'vault_docs', 'memory_notes', 'briefs', 'approvals', 'audit_log'];

test('ACCEPTANCE tenant isolation: each tenant sees only its own rows in every tenant table', async () => {
  for (const table of TABLES) {
    const a = await withTenant(A, (c) => c.query(`SELECT tenant_id FROM ${table}`));
    assert.ok(a.rowCount >= 1, `${table}: A should see its row`);
    assert.ok(a.rows.every((r) => r.tenant_id === A), `${table}: A saw a foreign row`);
    const b = await withTenant(B, (c) => c.query(`SELECT tenant_id FROM ${table}`));
    assert.ok(b.rows.every((r) => r.tenant_id === B), `${table}: B saw a foreign row`);
  }
});

test('tenant A cannot read, update or delete tenant B rows by id', async () => {
  const bDoc = (await withTenant(B, (c) => c.query('SELECT id FROM vault_docs'))).rows[0].id;
  const read = await withTenant(A, (c) => c.query('SELECT * FROM vault_docs WHERE id=$1', [bDoc]));
  assert.equal(read.rowCount, 0);
  const upd = await withTenant(A, (c) => c.query("UPDATE vault_docs SET title='pwned' WHERE id=$1", [bDoc]));
  assert.equal(upd.rowCount, 0);
  const del = await withTenant(A, (c) => c.query('DELETE FROM vault_docs WHERE id=$1', [bDoc]));
  assert.equal(del.rowCount, 0);
  const still = await withTenant(B, (c) => c.query('SELECT title FROM vault_docs WHERE id=$1', [bDoc]));
  assert.equal(still.rows[0].title, 'Beta doc');
});

test('tenant A cannot insert rows for tenant B (WITH CHECK)', async () => {
  await assert.rejects(withTenant(A, (c) => c.query("INSERT INTO vault_docs (tenant_id, doc_type, title) VALUES ($1,'Other','x')", [B])), /row-level security/);
  await assert.rejects(withTenant(A, (c) => c.query("INSERT INTO approvals (tenant_id, kind, summary, proposed_by) VALUES ($1,'send_brief','x','agent:evil')", [B])), /row-level security/);
});

test('no tenant context means no tenant rows at all', async () => {
  for (const table of TABLES) {
    const r = await withSystem((c) => c.query(`SELECT * FROM ${table}`));
    assert.equal(r.rowCount, 0, `${table} leaked rows without tenant context`);
  }
});

test('app role cannot bypass RLS or switch tenant mid-transaction through data', async () => {
  const role = (await withSystem((c) => c.query("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='hi_app'"))).rows[0];
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  await assert.rejects(withTenant("x' OR '1'='1", async () => {}), /invalid tenant id/);
});

test('ACCEPTANCE everything logged: audit log is append-only for the app role', async () => {
  await assert.rejects(withTenant(A, (c) => c.query('UPDATE audit_log SET action=$1', ['tampered'])), /permission denied|append-only/);
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM audit_log')), /permission denied|append-only/);
  const o = owner(db.ownerUrl); await o.connect();
  await assert.rejects(o.query("UPDATE audit_log SET action='x'"), /append-only/);
  await o.end();
});
