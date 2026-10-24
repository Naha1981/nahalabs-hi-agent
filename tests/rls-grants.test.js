import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startDb, owner } from './helpers.js';
import { saveUpload } from '../src/uploads.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, o, app, A, B;
test.before(async () => {
  db = await startDb(54362);
  o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('RLS A') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('RLS B') RETURNING id")).rows[0].id;
  await saveUpload(A, { filename: 'a-doc.txt', mime: 'text/plain', buffer: Buffer.from('alpha only') });
  app = new pg.Client({ connectionString: db.appUrl }); // the real app role, hi_app
  await app.connect();
});
test.after(async () => { await app.end(); await o.end(); await db.stop(); });

const setTenant = (t) => app.query("SELECT set_config('app.tenant_id', $1, false)", [t]);

test('app role is not superuser and cannot bypass RLS', async () => {
  const r = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual([r.rows[0].rolsuper, r.rows[0].rolbypassrls], [false, false]);
});

test('uploads are invisible without tenant context and across tenants', async () => {
  await setTenant('');
  assert.equal((await app.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 0);
  await setTenant(B);
  assert.equal((await app.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 0);
  await setTenant(A);
  assert.equal((await app.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
});

test('INSERT carrying another tenant id is rejected by the policy', async () => {
  await setTenant(A);
  await assert.rejects(
    app.query("INSERT INTO uploads (tenant_id, filename, mime, size_bytes, content) VALUES ($1, 'x.txt', 'text/plain', 1, '\\x00')", [B]),
    /row-level security/
  );
});

test('upload_budget: app role holds exactly the admission grant, no more', async () => {
  // the admission path needs SELECT + UPDATE(bytes_used); both work
  await app.query('SELECT bytes_used FROM upload_budget WHERE id = 1');
  await app.query('UPDATE upload_budget SET bytes_used = bytes_used + 0 WHERE id = 1');
  // everything else on the ledger is denied
  await assert.rejects(app.query('UPDATE upload_budget SET id = 2 WHERE id = 1'), /permission denied/);
  await assert.rejects(app.query('INSERT INTO upload_budget (id, bytes_used) VALUES (2, 0)'), /permission denied/);
  await assert.rejects(app.query('DELETE FROM upload_budget WHERE id = 1'), /permission denied/);
});

test('app role cannot create objects in the public schema', async () => {
  await assert.rejects(app.query('CREATE TABLE rls_probe (id int)'), /permission denied/);
});
