import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { saveUpload } from '../src/uploads.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, o, A, B;
test.before(async () => {
  db = await startDb(54361);
  o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Concurrency A') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Concurrency B') RETURNING id")).rows[0].id;
});
test.after(async () => { await o.end(); await db.stop(); });

const txt = (n) => Buffer.from('x'.repeat(n));
const attempt = (tenantId, name, buf) =>
  saveUpload(tenantId, { filename: name, mime: 'text/plain', buffer: buf }).then(() => 'ok').catch((e) => e.code || 'ERR');

test('tenant quota admission is atomic under concurrent same-tenant uploads', async () => {
  process.env.HI_UPLOAD_TENANT_QUOTA_BYTES = '1000';
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(A, `race-a-${i}.txt`, txt(200))));
    assert.deepEqual([...results].sort(), ['TENANT_QUOTA', 'TENANT_QUOTA', 'TENANT_QUOTA', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const used = (await o.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS s FROM uploads WHERE tenant_id=$1', [A])).rows[0].s;
    assert.equal(Number(used), 1000, 'stored bytes never exceed the tenant quota, exactly 5 x 200 admitted');
  } finally { delete process.env.HI_UPLOAD_TENANT_QUOTA_BYTES; }
});

test('global budget admission is atomic under concurrent cross-tenant uploads', async () => {
  // the ledger already holds 1000 bytes from the previous test; cap the total at 2000
  process.env.HI_UPLOAD_GLOBAL_BUDGET_BYTES = '2000';
  try {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => attempt(A, `race-g-a-${i}.txt`, txt(200))),
      ...Array.from({ length: 4 }, (_, i) => attempt(B, `race-g-b-${i}.txt`, txt(200))),
    ]);
    assert.equal(results.filter((r) => r === 'ok').length, 5);
    assert.equal(results.filter((r) => r === 'GLOBAL_BUDGET').length, 3);
    const led = (await o.query('SELECT bytes_used FROM upload_budget WHERE id=1')).rows[0].bytes_used;
    const sum = (await o.query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM uploads')).rows[0].s;
    assert.equal(Number(led), 2000, 'ledger never overshoots the shared budget');
    assert.equal(String(led), String(sum), 'ledger matches stored bytes after the race');
  } finally { delete process.env.HI_UPLOAD_GLOBAL_BUDGET_BYTES; }
});
